from __future__ import annotations

import json
import os
import re
import shutil
from dataclasses import dataclass, field, replace
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Dict, Mapping, Optional, Protocol, Sequence, Tuple

from .runners import (
    CheckSpec,
    LocalQoderRunner,
    ProcessResult,
    QoderRunnerConfig,
    RunnerConfigurationError,
    _run_process,
)
from .workspace import ArchiveWorkspaceBuilder


_CONTAINER_NAME = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$")
_ENVIRONMENT_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_SHA256_IMAGE = re.compile(r"^(?:.+@)?sha256:[0-9a-fA-F]{64}$")
_NUMERIC_USER = re.compile(r"^(\d+):(\d+)$")


@dataclass(frozen=True)
class ContainerMount:
    source: Path
    target: str
    read_only: bool = False

    def __post_init__(self) -> None:
        source = self.source.expanduser().resolve()
        target = PurePosixPath(self.target)
        if not source.exists():
            raise RunnerConfigurationError(f"container mount source does not exist: {source}")
        if not target.is_absolute() or ".." in target.parts:
            raise RunnerConfigurationError(f"unsafe container mount target: {self.target}")
        if "," in str(source) or "," in self.target:
            raise RunnerConfigurationError("container mount paths cannot contain commas")
        object.__setattr__(self, "source", source)


@dataclass(frozen=True)
class ContainerSpec:
    name: str
    image: str
    command: Tuple[str, ...]
    mounts: Tuple[ContainerMount, ...]
    environment: Mapping[str, str]
    workdir: str = "/workspace"
    entrypoint: Optional[str] = None
    network: str = "bridge"
    user: Optional[str] = None
    cpus: float = 2.0
    memory: str = "4g"
    pids_limit: int = 256
    tmpfs_size: str = "512m"
    timeout_seconds: int = 900
    labels: Mapping[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not _CONTAINER_NAME.fullmatch(self.name):
            raise RunnerConfigurationError(f"unsafe container name: {self.name}")
        if not self.image.strip() or (not self.entrypoint and not self.command):
            raise RunnerConfigurationError("container image and executable are required")
        if not PurePosixPath(self.workdir).is_absolute():
            raise RunnerConfigurationError("container workdir must be absolute")
        if not self.network or self.network == "host" or self.network.startswith("container:"):
            raise RunnerConfigurationError(f"unsafe container network: {self.network}")
        if self.cpus <= 0 or self.pids_limit < 16 or self.timeout_seconds < 1:
            raise RunnerConfigurationError("container resource limits must be positive")
        for name in self.environment:
            if not _ENVIRONMENT_NAME.fullmatch(name):
                raise RunnerConfigurationError(f"unsafe environment name: {name}")


class ContainerRuntime(Protocol):
    def ensure_ready(self, images: Sequence[str]) -> None:
        ...

    def run(self, spec: ContainerSpec) -> ProcessResult:
        ...


ProcessExecutor = Callable[..., ProcessResult]


class DockerCliRuntime:
    """Runs constrained one-shot containers and always removes them afterward."""

    _host_environment_names = (
        "PATH",
        "HOME",
        "LANG",
        "LC_ALL",
        "DOCKER_HOST",
        "DOCKER_CONTEXT",
        "DOCKER_CONFIG",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
    )

    def __init__(
        self,
        docker_binary: str = "docker",
        *,
        process_executor: ProcessExecutor = _run_process,
        control_timeout_seconds: int = 20,
    ) -> None:
        self.docker_binary = docker_binary
        self.process_executor = process_executor
        self.control_timeout_seconds = control_timeout_seconds

    def ensure_ready(self, images: Sequence[str]) -> None:
        binary = shutil.which(self.docker_binary)
        if binary is None:
            raise RunnerConfigurationError(
                f"docker executable not found: {self.docker_binary}"
            )
        version = self.process_executor(
            [binary, "version", "--format", "{{.Server.Version}}"],
            cwd=Path.cwd(),
            env=self._host_environment(),
            timeout_seconds=self.control_timeout_seconds,
        )
        if version.returncode != 0 or version.timed_out:
            raise RunnerConfigurationError("docker daemon is unavailable")
        for image in sorted(set(images)):
            inspected = self.process_executor(
                [binary, "image", "inspect", image, "--format", "{{.Id}}"],
                cwd=Path.cwd(),
                env=self._host_environment(),
                timeout_seconds=self.control_timeout_seconds,
            )
            if inspected.returncode != 0 or inspected.timed_out:
                raise RunnerConfigurationError(f"runner image is unavailable: {image}")

    def run(self, spec: ContainerSpec) -> ProcessResult:
        binary = shutil.which(self.docker_binary)
        if binary is None:
            raise RunnerConfigurationError(
                f"docker executable not found: {self.docker_binary}"
            )
        command = self.build_run_command(binary, spec)
        environment = self._host_environment()
        environment.update(spec.environment)
        result: Optional[ProcessResult] = None
        state: Mapping[str, Any] = {}
        removed = False
        try:
            result = self.process_executor(
                command,
                cwd=spec.mounts[0].source if spec.mounts else Path.cwd(),
                env=environment,
                timeout_seconds=spec.timeout_seconds,
            )
            try:
                state = self._inspect_state(binary, spec.name)
            except Exception:
                state = {}
        finally:
            try:
                removed = self._remove(binary, spec.name)
            except Exception:
                removed = False
        if result is None:
            raise RunnerConfigurationError(f"container did not start: {spec.name}")
        metadata = {
            "containerName": spec.name,
            "image": spec.image,
            "network": spec.network,
            "readOnlyRoot": True,
            "capDrop": ["ALL"],
            "noNewPrivileges": True,
            "pidsLimit": spec.pids_limit,
            "memory": spec.memory,
            "cpus": spec.cpus,
            "environmentNames": sorted(spec.environment),
            "state": state,
            "removed": removed,
        }
        return replace(result, metadata=metadata)

    @staticmethod
    def build_run_command(binary: str, spec: ContainerSpec) -> list[str]:
        command = [
            binary,
            "run",
            "--name",
            spec.name,
            "--pull",
            "never",
            "--init",
            "--workdir",
            spec.workdir,
            "--network",
            spec.network,
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges:true",
            "--pids-limit",
            str(spec.pids_limit),
            "--memory",
            spec.memory,
            "--cpus",
            str(spec.cpus),
            "--tmpfs",
            f"/tmp:rw,nosuid,nodev,size={spec.tmpfs_size}",
        ]
        if spec.user:
            command.extend(("--user", spec.user))
        if spec.entrypoint:
            command.extend(("--entrypoint", spec.entrypoint))
        for name, value in sorted(spec.labels.items()):
            command.extend(("--label", f"{name}={value}"))
        for mount in spec.mounts:
            value = f"type=bind,src={mount.source},dst={mount.target}"
            if mount.read_only:
                value += ",readonly"
            command.extend(("--mount", value))
        # Values are inherited through the Docker CLI process environment, so
        # secrets never appear in argv, logs, or the command summary.
        for name in sorted(spec.environment):
            command.extend(("--env", name))
        command.extend((spec.image, *spec.command))
        return command

    def _inspect_state(self, binary: str, name: str) -> Mapping[str, Any]:
        inspected = self.process_executor(
            [binary, "inspect", "--format", "{{json .State}}", name],
            cwd=Path.cwd(),
            env=self._host_environment(),
            timeout_seconds=self.control_timeout_seconds,
        )
        if inspected.returncode != 0 or inspected.timed_out:
            return {}
        try:
            value = json.loads(inspected.stdout.strip())
        except json.JSONDecodeError:
            return {}
        if not isinstance(value, Mapping):
            return {}
        allowed = ("Status", "Running", "Paused", "OOMKilled", "ExitCode", "StartedAt", "FinishedAt")
        return {key: value.get(key) for key in allowed if key in value}

    def _remove(self, binary: str, name: str) -> bool:
        removed = self.process_executor(
            [binary, "rm", "-f", name],
            cwd=Path.cwd(),
            env=self._host_environment(),
            timeout_seconds=self.control_timeout_seconds,
        )
        return removed.returncode == 0 and not removed.timed_out

    def _host_environment(self) -> Dict[str, str]:
        environment = {
            name: os.environ[name]
            for name in self._host_environment_names
            if name in os.environ
        }
        environment.setdefault("PATH", os.environ.get("PATH", ""))
        return environment


@dataclass(frozen=True)
class DockerQoderRunnerConfig:
    image: str
    check_image: Optional[str] = None
    docker_binary: str = "docker"
    qoder_binary: str = "qodercli"
    qoder_network: str = "bridge"
    check_network: str = "none"
    cpus: float = 2.0
    memory: str = "4g"
    pids_limit: int = 256
    tmpfs_size: str = "512m"
    container_user: str = "10001:10001"
    require_image_digest: bool = True
    require_qoder_token: bool = True
    environment_names: Tuple[str, ...] = (
        "QODER_PERSONAL_ACCESS_TOKEN",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
    )

    def __post_init__(self) -> None:
        images = (self.image, self.check_image or self.image)
        if any(not image.strip() for image in images):
            raise RunnerConfigurationError("docker runner image is required")
        if self.require_image_digest and any(
            not _SHA256_IMAGE.fullmatch(image) for image in images
        ):
            raise RunnerConfigurationError(
                "production runner images must use a sha256 image id or repository digest"
            )
        if self.check_network != "none":
            raise RunnerConfigurationError("hidden-test containers must use network=none")
        if self.qoder_network == "host" or self.qoder_network.startswith("container:"):
            raise RunnerConfigurationError("qoder container cannot use a shared host network")
        if self.cpus <= 0 or self.pids_limit < 16:
            raise RunnerConfigurationError("docker runner resource limits must be positive")
        user = _NUMERIC_USER.fullmatch(self.container_user)
        if user is None or user.group(1) == "0":
            raise RunnerConfigurationError(
                "docker runner must use a non-root numeric uid:gid"
            )


class DockerQoderRunner(LocalQoderRunner):
    """Runs Qoder and hidden checks in separate, constrained containers."""

    def __init__(
        self,
        config: QoderRunnerConfig,
        docker_config: DockerQoderRunnerConfig,
        *,
        runtime: Optional[ContainerRuntime] = None,
        workspace_builder: Optional[ArchiveWorkspaceBuilder] = None,
    ) -> None:
        super().__init__(config, workspace_builder=workspace_builder)
        self.docker_config = docker_config
        self.runtime = runtime or DockerCliRuntime(docker_config.docker_binary)
        self._runtime_ready = False

    def _validate_runtime(self) -> None:
        if (
            self.docker_config.require_qoder_token
            and not os.environ.get("QODER_PERSONAL_ACCESS_TOKEN", "").strip()
        ):
            raise RunnerConfigurationError(
                "QODER_PERSONAL_ACCESS_TOKEN is required by DockerQoderRunner"
            )
        if not self._runtime_ready:
            self.runtime.ensure_ready(
                (self.docker_config.image, self._check_image())
            )
            self._runtime_ready = True

    def _run_agent(
        self,
        *,
        prompt_path: Path,
        qoder_config_dir: Path,
        workspace: Path,
        run_id: str,
    ) -> ProcessResult:
        self._prepare_writable_mount(workspace)
        self._prepare_writable_mount(qoder_config_dir)
        prompt_target = "/run/visionowl/task-and-skill.md"
        config_target = "/run/visionowl/qoder-config"
        command = (
            self.docker_config.qoder_binary,
            "--attachment",
            prompt_target,
            "-p",
            "严格按照附件中的开发需求和 Skill 修改当前工作区，完成后执行可见测试并简要报告结果。",
            "-m",
            self.config.model,
            "--output-format",
            "json",
            "--permission-mode",
            "accept_edits",
            "--max-turns",
            str(self.config.max_turns),
            "--no-session-persistence",
            "--config-dir",
            config_target,
            "-w",
            "/workspace",
        )
        return self.runtime.run(
            self._container_spec(
                name=f"visionowl-skill-agent-{run_id[:12]}",
                image=self.docker_config.image,
                command=command,
                mounts=(
                    ContainerMount(workspace, "/workspace"),
                    ContainerMount(prompt_path, prompt_target, read_only=True),
                    ContainerMount(qoder_config_dir, config_target),
                ),
                environment=self._agent_environment(),
                network=self.docker_config.qoder_network,
                timeout_seconds=self.config.timeout_seconds,
                stage="agent",
                run_id=run_id,
            )
        )

    def _run_check(self, check: CheckSpec, workspace: Path) -> ProcessResult:
        check_id = os.urandom(6).hex()
        return self.runtime.run(
            self._container_spec(
                name=f"visionowl-skill-check-{check_id}",
                image=self._check_image(),
                command=check.command,
                mounts=(ContainerMount(workspace, "/workspace"),),
                environment={
                    "HOME": "/tmp/visionowl-home",
                    "VISIONOWL_SKILL_LAB": "1",
                },
                network="none",
                timeout_seconds=self.config.check_timeout_seconds,
                stage="hidden-check",
                run_id=check_id,
            )
        )

    def _container_spec(
        self,
        *,
        name: str,
        image: str,
        command: Tuple[str, ...],
        mounts: Tuple[ContainerMount, ...],
        environment: Mapping[str, str],
        network: str,
        timeout_seconds: int,
        stage: str,
        run_id: str,
    ) -> ContainerSpec:
        return ContainerSpec(
            name=name,
            image=image,
            entrypoint=command[0],
            command=command[1:],
            mounts=mounts,
            environment=environment,
            network=network,
            user=self._container_user(),
            cpus=self.docker_config.cpus,
            memory=self.docker_config.memory,
            pids_limit=self.docker_config.pids_limit,
            tmpfs_size=self.docker_config.tmpfs_size,
            timeout_seconds=timeout_seconds,
            labels={
                "visionowl.component": "skill-lab",
                "visionowl.stage": stage,
                "visionowl.run-id": run_id,
            },
        )

    def _agent_environment(self) -> Dict[str, str]:
        environment = {
            name: os.environ[name]
            for name in self.docker_config.environment_names
            if name in os.environ
        }
        environment.update(
            {
                "HOME": "/tmp/visionowl-home",
                "NO_COLOR": "1",
                "VISIONOWL_SKILL_LAB": "1",
            }
        )
        return environment

    def _container_user(self) -> str:
        return self.docker_config.container_user

    def _prepare_writable_mount(self, root: Path) -> None:
        user = _NUMERIC_USER.fullmatch(self.docker_config.container_user)
        assert user is not None
        uid, gid = int(user.group(1)), int(user.group(2))
        current_uid = os.geteuid() if hasattr(os, "geteuid") else uid
        current_gid = os.getegid() if hasattr(os, "getegid") else gid
        if current_uid == uid and current_gid == gid:
            return
        if current_uid != 0:
            raise RunnerConfigurationError(
                "controller cannot prepare Docker mounts for the configured uid:gid; "
                "run the controller as that user or choose its uid:gid"
            )
        os.chown(root, uid, gid)
        for path in root.rglob("*"):
            if path.is_symlink():
                os.lchown(path, uid, gid)
            else:
                os.chown(path, uid, gid)

    def _check_image(self) -> str:
        return self.docker_config.check_image or self.docker_config.image

    def _agent_command_summary(self) -> str:
        return (
            f"docker:{self.docker_config.image} {self.docker_config.qoder_binary} "
            f"-m {self.config.model} --max-turns {self.config.max_turns}"
        )

    @staticmethod
    def _provider() -> str:
        return "qoder-docker"
