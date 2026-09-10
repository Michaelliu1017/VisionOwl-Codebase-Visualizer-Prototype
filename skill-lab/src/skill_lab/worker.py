from __future__ import annotations

import logging
import os
import signal
import socket
import threading
import time
from dataclasses import dataclass
from typing import Any, Mapping, Sequence, Tuple

from redis import Redis
from redis.exceptions import RedisError, ResponseError

from .core_client import CoreClient, CoreClientConfig
from .processor import SkillLabProcessorConfig, SkillLabRunProcessor


LOGGER = logging.getLogger("visionowl.skill_lab.worker")


@dataclass(frozen=True)
class WorkerConfig:
    redis_url: str
    core_base_url: str
    service_token: str
    stream: str = "skilllab:tasks"
    group: str = "skill-lab-workers"
    consumer: str = ""
    block_milliseconds: int = 5_000
    claim_idle_milliseconds: int = 15 * 60 * 1_000
    retry_seconds: float = 5.0

    def __post_init__(self) -> None:
        if not self.redis_url or not self.core_base_url or not self.service_token:
            raise ValueError(
                "REDIS_URL, CORE_BASE_URL and INTEGRATION_SERVICE_TOKEN are required"
            )
        if min(self.block_milliseconds, self.claim_idle_milliseconds) < 1:
            raise ValueError("Redis worker timing values must be positive")

    @classmethod
    def from_env(cls) -> "WorkerConfig":
        return cls(
            redis_url=os.environ.get("REDIS_URL", ""),
            core_base_url=os.environ.get("CORE_BASE_URL", ""),
            service_token=os.environ.get("INTEGRATION_SERVICE_TOKEN", ""),
            stream=os.environ.get("SKILLLAB_STREAM", "skilllab:tasks"),
            group=os.environ.get("SKILLLAB_CONSUMER_GROUP", "skill-lab-workers"),
            consumer=os.environ.get("SKILLLAB_CONSUMER_NAME")
            or f"{socket.gethostname()}-{os.getpid()}",
            block_milliseconds=_int_env("SKILLLAB_REDIS_BLOCK_MS", 5_000),
            claim_idle_milliseconds=_int_env(
                "SKILLLAB_REDIS_CLAIM_IDLE_MS", 15 * 60 * 1_000
            ),
            retry_seconds=_float_env("SKILLLAB_WORKER_RETRY_SECONDS", 5.0),
        )


class SkillLabWorker:
    """Reliable Redis Stream consumer for one-shot Skill Lab runs."""

    def __init__(
        self,
        redis_client: Redis,
        processor: SkillLabRunProcessor,
        config: WorkerConfig,
    ) -> None:
        self.redis = redis_client
        self.processor = processor
        self.config = config
        self.stopping = threading.Event()

    def stop(self) -> None:
        self.stopping.set()

    def run_forever(self) -> None:
        self._ensure_group()
        LOGGER.info(
            "Skill Lab worker ready stream=%s group=%s consumer=%s",
            self.config.stream,
            self.config.group,
            self.config.consumer,
        )
        while not self.stopping.is_set():
            try:
                messages = self._claim_stale()
                if not messages:
                    messages = self._read_new()
                for message_id, fields in messages:
                    if self.stopping.is_set():
                        return
                    self._handle(message_id, fields)
            except RedisError as error:
                LOGGER.warning("Redis worker error: %s", error)
                self.stopping.wait(self.config.retry_seconds)
            except Exception:
                LOGGER.exception("Unexpected Skill Lab worker loop error")
                self.stopping.wait(self.config.retry_seconds)

    def _ensure_group(self) -> None:
        try:
            self.redis.xgroup_create(
                self.config.stream,
                self.config.group,
                id="0",
                mkstream=True,
            )
        except ResponseError as error:
            if "BUSYGROUP" not in str(error):
                raise

    def _claim_stale(self) -> list[Tuple[str, Mapping[str, str]]]:
        response = self.redis.xautoclaim(
            self.config.stream,
            self.config.group,
            self.config.consumer,
            min_idle_time=self.config.claim_idle_milliseconds,
            start_id="0-0",
            count=1,
        )
        if not isinstance(response, (list, tuple)) or len(response) < 2:
            return []
        return _messages(response[1])

    def _read_new(self) -> list[Tuple[str, Mapping[str, str]]]:
        response = self.redis.xreadgroup(
            self.config.group,
            self.config.consumer,
            streams={self.config.stream: ">"},
            count=1,
            block=self.config.block_milliseconds,
        )
        if not response:
            return []
        messages: list[Tuple[str, Mapping[str, str]]] = []
        for _, entries in response:
            messages.extend(_messages(entries))
        return messages

    def _handle(self, message_id: str, fields: Mapping[str, str]) -> None:
        run_id = fields.get("runId")
        if (
            fields.get("schemaVersion") != "1.0"
            or fields.get("kind") != "skill_evaluate_optimize"
            or not run_id
        ):
            LOGGER.error("Discarding invalid Skill Lab message id=%s", message_id)
            self._ack(message_id)
            return
        LOGGER.info("Processing Skill Lab run=%s message=%s", run_id, message_id)
        try:
            outcome = self.processor.process(run_id)
        except Exception:
            # Core could not be reached to record a terminal failure. Keep the
            # message pending so XAUTOCLAIM can safely retry it later.
            LOGGER.exception("Skill Lab run remains pending run=%s", run_id)
            return
        self._ack(message_id)
        LOGGER.info(
            "Skill Lab run finished run=%s decision=%s accepted=%d skipped=%s",
            outcome.run_id,
            outcome.decision,
            outcome.accepted_skills,
            outcome.skipped,
        )

    def _ack(self, message_id: str) -> None:
        self.redis.xack(self.config.stream, self.config.group, message_id)


def _messages(value: Any) -> list[Tuple[str, Mapping[str, str]]]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        return []
    result: list[Tuple[str, Mapping[str, str]]] = []
    for item in value:
        if not isinstance(item, Sequence) or len(item) != 2:
            continue
        message_id, fields = item
        if isinstance(message_id, bytes):
            message_id = message_id.decode("utf-8")
        if not isinstance(message_id, str) or not isinstance(fields, Mapping):
            continue
        normalized = {
            (key.decode("utf-8") if isinstance(key, bytes) else str(key)):
            (raw.decode("utf-8") if isinstance(raw, bytes) else str(raw))
            for key, raw in fields.items()
        }
        result.append((message_id, normalized))
    return result


def main() -> int:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    worker_config = WorkerConfig.from_env()
    core = CoreClient(
        CoreClientConfig(
            base_url=worker_config.core_base_url,
            service_token=worker_config.service_token,
            timeout_seconds=_float_env("CORE_TIMEOUT_SECONDS", 180.0),
        )
    )
    redis_client = Redis.from_url(worker_config.redis_url, decode_responses=True)
    worker = SkillLabWorker(
        redis_client,
        SkillLabRunProcessor(core, SkillLabProcessorConfig.from_env()),
        worker_config,
    )

    def stop(_signum: int, _frame: object) -> None:
        worker.stop()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        worker.run_forever()
    finally:
        core.close()
        redis_client.close()
    return 0


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError as error:
        raise ValueError(f"{name} must be an integer") from error


def _float_env(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError as error:
        raise ValueError(f"{name} must be numeric") from error


if __name__ == "__main__":
    raise SystemExit(main())
