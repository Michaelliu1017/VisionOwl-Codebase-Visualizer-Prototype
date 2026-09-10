from __future__ import annotations

import difflib
import json
import os
import re
import shutil
import signal
import subprocess
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from .models import CheckResult, EvaluationTask, ExecutionResult, SkillVersion
from .workspace import ArchiveWorkspaceBuilder


class RunnerConfigurationError(ValueError):
    pass


@dataclass(frozen=True)
class QoderRunnerConfig:
    repository: Path
    qoder_binary: str = "qodercli"
    model: str = "Performance"
    max_turns: int = 25
    timeout_seconds: int = 900
    check_timeout_seconds: int = 120
    artifact_root: Optional[Path] = None
    hidden_tests_root: Optional[Path] = None
    temporary_root: Optional[Path] = None
    max_diff_bytes: int = 1_000_000
    execution_user: Optional[str] = None
    execution_home: str = "/tmp/visionowl-runner-home"
    environment_names: Tuple[str, ...] = (
        "PATH",
        "HOME",
        "LANG",
        "LC_ALL",
        "TMPDIR",
        "QODER_PERSONAL_ACCESS_TOKEN",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
    )

    def __post_init__(self) -> None:
        if self.max_turns < 1:
            raise RunnerConfigurationError("max turns must be positive")
        if self.timeout_seconds < 1 or self.check_timeout_seconds < 1:
            raise RunnerConfigurationError("runner timeouts must be positive")
        if self.execution_user and not re.fullmatch(r"\d+:\d+", self.execution_user):
            raise RunnerConfigurationError("execution user must be a numeric uid:gid")


@dataclass(frozen=True)
class ProcessResult:
    returncode: int
    stdout: str
    stderr: str
    duration_ms: int
    timed_out: bool = False
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class CheckSpec:
    name: str
    command: Tuple[str, ...]
    critical: bool = True
    rule: Optional[str] = None


@dataclass(frozen=True)
class HiddenFileSpec:
    source: str
    target: str


@dataclass(frozen=True)
class TaskRunnerSpec:
    checks: Tuple[CheckSpec, ...] = ()
    hidden_files: Tuple[HiddenFileSpec, ...] = ()
    ignored_paths: Tuple[str, ...] = (
        ".skill-lab-hidden",
        "node_modules",
        ".qoder",
    )

    @classmethod
    def from_task(cls, task: EvaluationTask) -> "TaskRunnerSpec":
        raw = task.metadata.get("runner", {})
        if not isinstance(raw, Mapping):
            raise RunnerConfigurationError(f"task {task.id} runner metadata must be an object")

        checks: List[CheckSpec] = []
        for index, item in enumerate(raw.get("checks", [])):
            if not isinstance(item, Mapping):
                raise RunnerConfigurationError(
                    f"task {task.id} check {index} must be an object"
                )
            command = item.get("command")
            if not isinstance(command, list) or not command or not all(
                isinstance(part, str) and part for part in command
            ):
                raise RunnerConfigurationError(
                    f"task {task.id} check {index} needs a non-empty command array"
                )
            checks.append(
                CheckSpec(
                    name=str(item.get("name") or f"check-{index + 1}"),
                    command=tuple(command),
                    critical=bool(item.get("critical", True)),
                    rule=str(item["rule"]) if item.get("rule") else None,
                )
            )

        hidden_files: List[HiddenFileSpec] = []
        for index, item in enumerate(raw.get("hiddenFiles", [])):
            if not isinstance(item, Mapping) or not item.get("source") or not item.get("target"):
                raise RunnerConfigurationError(
                    f"task {task.id} hidden file {index} needs source and target"
                )
            hidden_files.append(
                HiddenFileSpec(source=str(item["source"]), target=str(item["target"]))
            )

        ignored = raw.get("ignoredPaths", cls.ignored_paths)
        if not isinstance(ignored, (list, tuple)) or not all(
            isinstance(item, str) for item in ignored
        ):
            raise RunnerConfigurationError(f"task {task.id} ignoredPaths must be a string array")
        return cls(
            checks=tuple(checks),
            hidden_files=tuple(hidden_files),
            ignored_paths=tuple(ignored),
        )


class LocalQoderRunner:
    """Executes one Qoder coding attempt in a disposable source archive."""

    def __init__(
        self,
        config: QoderRunnerConfig,
        *,
        workspace_builder: Optional[ArchiveWorkspaceBuilder] = None,
    ) -> None:
        self.config = config
        self.repository = config.repository.expanduser().resolve()
        if config.temporary_root is not None:
            config.temporary_root.mkdir(parents=True, exist_ok=True)
        self.workspace_builder = workspace_builder or ArchiveWorkspaceBuilder(
            temporary_root=config.temporary_root
        )

    def execute(self, skill: SkillVersion, task: EvaluationTask) -> ExecutionResult:
        run_id = str(uuid.uuid4())
        started = time.monotonic()
        spec = TaskRunnerSpec.from_task(task)
        self._validate_runtime()

        artifact_dir = self._artifact_dir(run_id)
        lease = self.workspace_builder.build(self.repository, task.base_sha)
        config_root = Path(
            tempfile.mkdtemp(
                prefix=f"visionowl-qoder-{run_id[:8]}-",
                dir=str(self.config.temporary_root) if self.config.temporary_root else None,
            )
        )
        try:
            workspace = lease.path
            baseline = _snapshot_tree(workspace, ignored_paths=spec.ignored_paths)
            prompt_path = config_root / "task-and-skill.md"
            prompt_path.write_text(
                self._build_prompt(skill, task), encoding="utf-8"
            )
            qoder_config_dir = config_root / "qoder-config"
            qoder_config_dir.mkdir(mode=0o700)
            self._prepare_execution_paths(workspace, config_root)
            qoder_result = self._run_agent(
                prompt_path=prompt_path,
                qoder_config_dir=qoder_config_dir,
                workspace=workspace,
                run_id=run_id,
            )
            qoder_result = _redact_process_result(
                qoder_result, self._sensitive_environment_values()
            )

            after_agent = _snapshot_tree(workspace, ignored_paths=spec.ignored_paths)
            changed_files, diff = _compare_snapshots(
                baseline,
                after_agent,
                max_bytes=self.config.max_diff_bytes,
            )
            violations = _scope_violations(
                changed_files,
                allowed_paths=task.allowed_paths,
                forbidden_paths=task.forbidden_paths,
            )

            self._inject_hidden_files(spec.hidden_files, workspace)
            checks, check_traces = self._run_checks(spec.checks, workspace)
            checks.insert(
                0,
                CheckResult(
                    name="qoder-exit",
                    passed=qoder_result.returncode == 0 and not qoder_result.timed_out,
                    critical=True,
                    details=(
                        "Qoder completed"
                        if qoder_result.returncode == 0 and not qoder_result.timed_out
                        else _process_failure_details(qoder_result)
                    ),
                ),
            )
            missing_rules = [
                item.rule
                for item, check in zip(spec.checks, checks[1:])
                if item.rule and not check.passed
            ]
            commands = (
                self._agent_command_summary(),
                *(" ".join(item.command) for item in spec.checks),
            )
            duration_ms = int((time.monotonic() - started) * 1000)
            artifact_refs = self._write_artifacts(
                artifact_dir,
                prompt=prompt_path.read_text(encoding="utf-8"),
                qoder=qoder_result,
                diff=diff,
                checks=check_traces,
            )
            return ExecutionResult(
                run_id=run_id,
                task_id=task.id,
                skill_version=skill.version,
                checks=tuple(checks),
                changed_files=tuple(changed_files),
                diff=diff,
                commands=commands,
                violations=tuple(violations),
                trace={
                    "missing_rules": missing_rules,
                    "required_rules": list(task.required_rules),
                    "qoder_returncode": qoder_result.returncode,
                    "qoder_timed_out": qoder_result.timed_out,
                    "qoder_stdout_tail": _tail(qoder_result.stdout),
                    "qoder_stderr_tail": _tail(qoder_result.stderr),
                    "runtime": dict(qoder_result.metadata),
                    "checks": check_traces,
                    "artifacts": artifact_refs,
                },
                duration_ms=duration_ms,
                efficiency_score=_efficiency_score(
                    duration_ms, self.config.timeout_seconds * 1000
                ),
                provider=self._provider(),
            )
        finally:
            lease.close()
            shutil.rmtree(config_root, ignore_errors=True)

    def _validate_runtime(self) -> None:
        if shutil.which(self.config.qoder_binary) is None:
            raise RunnerConfigurationError(
                f"qoder executable not found: {self.config.qoder_binary}"
            )
        if self.config.execution_user and shutil.which("setpriv") is None:
            raise RunnerConfigurationError("setpriv is required for a downgraded local runner")

    def _run_agent(
        self,
        *,
        prompt_path: Path,
        qoder_config_dir: Path,
        workspace: Path,
        run_id: str,
    ) -> ProcessResult:
        del run_id
        binary = shutil.which(self.config.qoder_binary)
        assert binary is not None
        return _run_process(
            self._execution_command([
                binary,
                "--attachment",
                str(prompt_path),
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
                str(qoder_config_dir),
                "-w",
                str(workspace),
            ]),
            cwd=workspace,
            env=self._environment(),
            timeout_seconds=self.config.timeout_seconds,
        )

    def _run_check(self, check: CheckSpec, workspace: Path) -> ProcessResult:
        return _run_process(
            self._execution_command(list(check.command)),
            cwd=workspace,
            env=self._environment(),
            timeout_seconds=self.config.check_timeout_seconds,
        )

    def _agent_command_summary(self) -> str:
        return (
            f"{self.config.qoder_binary} -m {self.config.model} "
            f"--max-turns {self.config.max_turns}"
        )

    @staticmethod
    def _provider() -> str:
        return "qoder-local"

    def _build_prompt(self, skill: SkillVersion, task: EvaluationTask) -> str:
        allowed = "\n".join(f"- {item}" for item in task.allowed_paths) or "- 未限制"
        forbidden = "\n".join(f"- {item}" for item in task.forbidden_paths) or "- 无"
        return f"""# Skill Lab 真实代码任务

## 开发需求

{task.requirement}

## 当前候选 Skill

版本：{skill.version}

{skill.content.strip()}

## 修改边界

允许修改：
{allowed}

禁止修改：
{forbidden}

## 强制执行约束

- 只修改完成需求必需的文件。
- 不得执行 git push、git reset、改写历史或读取仓库外文件。
- 不得寻找隐藏测试、后续 Commit 或标准答案。
- 不得修改测试或降低现有断言。
- 完成后运行仓库中可见的相关测试；若环境缺失，明确报告，不得伪造结果。
"""

    def _environment(self) -> Dict[str, str]:
        environment = {
            name: os.environ[name]
            for name in self.config.environment_names
            if name in os.environ
        }
        environment.setdefault("PATH", os.environ.get("PATH", ""))
        if self.config.execution_user:
            environment["HOME"] = self.config.execution_home
        environment["VISIONOWL_SKILL_LAB"] = "1"
        return environment

    def _execution_command(self, command: Sequence[str]) -> List[str]:
        if not self.config.execution_user:
            return list(command)
        uid, gid = self.config.execution_user.split(":", 1)
        binary = shutil.which("setpriv")
        if binary is None:
            raise RunnerConfigurationError("setpriv is unavailable")
        return [
            binary,
            f"--reuid={uid}",
            f"--regid={gid}",
            "--clear-groups",
            "--",
            *command,
        ]

    def _prepare_execution_paths(self, workspace: Path, config_root: Path) -> None:
        if not self.config.execution_user:
            return
        if not hasattr(os, "geteuid") or os.geteuid() != 0:
            raise RunnerConfigurationError(
                "a downgraded local runner requires a root controller inside its container"
            )
        uid_text, gid_text = self.config.execution_user.split(":", 1)
        uid, gid = int(uid_text), int(gid_text)
        home = Path(self.config.execution_home)
        home.mkdir(parents=True, exist_ok=True)
        for root in (workspace, config_root, home):
            os.chown(root, uid, gid)
            for path in root.rglob("*"):
                if path.is_symlink():
                    os.lchown(path, uid, gid)
                else:
                    os.chown(path, uid, gid)

    def _sensitive_environment_values(self) -> Tuple[str, ...]:
        markers = ("TOKEN", "KEY", "SECRET", "PASSWORD", "CREDENTIAL", "PROXY")
        return tuple(
            value
            for name in self.config.environment_names
            if any(marker in name.upper() for marker in markers)
            for value in (os.environ.get(name, ""),)
            if len(value) >= 8
        )

    def _inject_hidden_files(
        self,
        hidden_files: Sequence[HiddenFileSpec],
        workspace: Path,
    ) -> None:
        if hidden_files and self.config.hidden_tests_root is None:
            raise RunnerConfigurationError("hidden tests root is required by this task")
        root = self.config.hidden_tests_root.resolve() if self.config.hidden_tests_root else None
        for item in hidden_files:
            assert root is not None
            source = _safe_child(root, item.source)
            target = _safe_child(workspace, item.target)
            if not source.is_file():
                raise RunnerConfigurationError(f"hidden test file not found: {item.source}")
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)

    def _run_checks(
        self,
        checks: Sequence[CheckSpec],
        workspace: Path,
    ) -> Tuple[List[CheckResult], List[Mapping[str, Any]]]:
        results: List[CheckResult] = []
        traces: List[Mapping[str, Any]] = []
        for check in checks:
            completed = self._run_check(check, workspace)
            completed = _redact_process_result(
                completed, self._sensitive_environment_values()
            )
            passed = completed.returncode == 0 and not completed.timed_out
            results.append(
                CheckResult(
                    name=check.name,
                    passed=passed,
                    critical=check.critical,
                    details=("passed" if passed else _process_failure_details(completed)),
                )
            )
            traces.append(
                {
                    "name": check.name,
                    "command": list(check.command),
                    "returncode": completed.returncode,
                    "timedOut": completed.timed_out,
                    "durationMs": completed.duration_ms,
                    "stdoutTail": _tail(completed.stdout),
                    "stderrTail": _tail(completed.stderr),
                    "runtime": dict(completed.metadata),
                }
            )
        return results, traces

    def _artifact_dir(self, run_id: str) -> Optional[Path]:
        if self.config.artifact_root is None:
            return None
        path = self.config.artifact_root.resolve() / run_id
        path.mkdir(parents=True, exist_ok=True)
        return path

    @staticmethod
    def _write_artifacts(
        directory: Optional[Path],
        *,
        prompt: str,
        qoder: ProcessResult,
        diff: str,
        checks: Sequence[Mapping[str, Any]],
    ) -> Mapping[str, str]:
        if directory is None:
            return {}
        values = {
            "prompt": ("prompt.md", prompt),
            "qoderStdout": ("qoder.stdout.log", qoder.stdout),
            "qoderStderr": ("qoder.stderr.log", qoder.stderr),
            "diff": ("changes.diff", diff),
            "checks": ("checks.json", json.dumps(checks, ensure_ascii=False, indent=2)),
        }
        refs: Dict[str, str] = {}
        for key, (name, content) in values.items():
            path = directory / name
            path.write_text(content, encoding="utf-8")
            refs[key] = str(path)
        return refs


def _run_process(
    command: Sequence[str],
    *,
    cwd: Path,
    env: Mapping[str, str],
    timeout_seconds: int,
) -> ProcessResult:
    started = time.monotonic()
    process = subprocess.Popen(
        list(command),
        cwd=str(cwd),
        env=dict(env),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    timed_out = False
    try:
        stdout, stderr = process.communicate(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(process.pid, signal.SIGTERM)
        try:
            stdout, stderr = process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate()
    return ProcessResult(
        returncode=process.returncode if process.returncode is not None else -1,
        stdout=stdout,
        stderr=stderr,
        duration_ms=int((time.monotonic() - started) * 1000),
        timed_out=timed_out,
    )


def _snapshot_tree(root: Path, *, ignored_paths: Sequence[str]) -> Mapping[str, bytes]:
    snapshot: Dict[str, bytes] = {}
    ignored = tuple(_normalize_relative(item) for item in ignored_paths)
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if any(_path_matches(relative, item) for item in ignored):
            continue
        if path.is_symlink():
            snapshot[relative] = b"SYMLINK\x00" + os.readlink(path).encode(
                "utf-8", errors="surrogateescape"
            )
        elif path.is_file():
            snapshot[relative] = path.read_bytes()
    return snapshot


def _compare_snapshots(
    before: Mapping[str, bytes],
    after: Mapping[str, bytes],
    *,
    max_bytes: int,
) -> Tuple[List[str], str]:
    changed = sorted(
        path for path in set(before) | set(after) if before.get(path) != after.get(path)
    )
    chunks: List[str] = []
    used = 0
    for path in changed:
        old = before.get(path, b"")
        new = after.get(path, b"")
        if _looks_binary(old) or _looks_binary(new):
            chunk = f"Binary file changed: {path}\n"
        else:
            chunk = "".join(
                difflib.unified_diff(
                    old.decode("utf-8", errors="replace").splitlines(keepends=True),
                    new.decode("utf-8", errors="replace").splitlines(keepends=True),
                    fromfile=f"a/{path}" if path in before else "/dev/null",
                    tofile=f"b/{path}" if path in after else "/dev/null",
                )
            )
        encoded = chunk.encode("utf-8")
        if used + len(encoded) > max_bytes:
            chunks.append("\n... diff truncated by Skill Lab ...\n")
            break
        chunks.append(chunk)
        used += len(encoded)
    return changed, "".join(chunks)


def _scope_violations(
    changed_files: Iterable[str],
    *,
    allowed_paths: Sequence[str],
    forbidden_paths: Sequence[str],
) -> List[str]:
    allowed = tuple(_normalize_relative(item) for item in allowed_paths)
    forbidden = tuple(_normalize_relative(item) for item in forbidden_paths)
    violations: List[str] = []
    for path in changed_files:
        if allowed and not any(_path_matches(path, prefix) for prefix in allowed):
            violations.append(f"changed file outside allowed paths: {path}")
        if any(_path_matches(path, prefix) for prefix in forbidden):
            violations.append(f"changed forbidden path: {path}")
    return violations


def _normalize_relative(value: str) -> str:
    raw = value.replace("\\", "/")
    candidate = PurePosixPath(raw)
    if candidate.is_absolute() or ".." in candidate.parts:
        raise RunnerConfigurationError(f"unsafe relative path: {value}")
    normalized = candidate.as_posix()
    while normalized.startswith("./"):
        normalized = normalized[2:]
    if not normalized or normalized == ".":
        raise RunnerConfigurationError(f"unsafe relative path: {value}")
    return normalized.rstrip("/")


def _path_matches(path: str, prefix: str) -> bool:
    return path == prefix or path.startswith(f"{prefix}/")


def _safe_child(root: Path, relative: str) -> Path:
    normalized = _normalize_relative(relative)
    target = (root / normalized).resolve()
    try:
        target.relative_to(root.resolve())
    except ValueError as error:
        raise RunnerConfigurationError(f"path escapes configured root: {relative}") from error
    return target


def _looks_binary(value: bytes) -> bool:
    return b"\x00" in value[:8_192]


def _tail(value: str, limit: int = 4_000) -> str:
    return value[-limit:]


def _process_failure_details(result: ProcessResult) -> str:
    if result.timed_out:
        return "timed out"
    detail = _tail(result.stderr.strip() or result.stdout.strip(), 1_000)
    return f"exit {result.returncode}: {detail}" if detail else f"exit {result.returncode}"


def _redact_process_result(
    result: ProcessResult,
    sensitive_values: Sequence[str],
) -> ProcessResult:
    stdout = result.stdout
    stderr = result.stderr
    for value in sorted(set(sensitive_values), key=len, reverse=True):
        stdout = stdout.replace(value, "[REDACTED]")
        stderr = stderr.replace(value, "[REDACTED]")
    return ProcessResult(
        returncode=result.returncode,
        stdout=stdout,
        stderr=stderr,
        duration_ms=result.duration_ms,
        timed_out=result.timed_out,
        metadata=result.metadata,
    )


def _efficiency_score(duration_ms: int, budget_ms: int) -> float:
    if budget_ms <= 0:
        return 0.0
    consumed = min(1.0, duration_ms / budget_ms)
    return round(max(0.0, 100.0 - (consumed * 20.0)), 2)
