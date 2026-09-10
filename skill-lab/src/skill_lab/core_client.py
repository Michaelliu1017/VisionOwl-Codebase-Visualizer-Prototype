from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any, Mapping, Optional

import httpx


class CoreClientError(RuntimeError):
    pass


@dataclass(frozen=True)
class CoreClientConfig:
    base_url: str
    service_token: str
    timeout_seconds: float = 120.0


class CoreClient:
    """Versioned machine client for VisionOwl Core.

    The service token is only placed in the request header and never included
    in exceptions, reports, or worker logs.
    """

    def __init__(
        self,
        config: CoreClientConfig,
        *,
        transport: Optional[httpx.BaseTransport] = None,
    ) -> None:
        if not config.base_url.strip() or not config.service_token.strip():
            raise CoreClientError("CORE_BASE_URL and INTEGRATION_SERVICE_TOKEN are required")
        self._client = httpx.Client(
            base_url=config.base_url.rstrip("/"),
            timeout=config.timeout_seconds,
            transport=transport,
            headers={
                "accept": "application/json",
                "x-visionowl-service-token": config.service_token,
            },
            follow_redirects=True,
        )

    def close(self) -> None:
        self._client.close()

    def get_command(self, run_id: str) -> Mapping[str, Any]:
        value = self._json("GET", f"/internal/v1/skilllab-runs/{run_id}/command")
        if not isinstance(value, Mapping):
            raise CoreClientError("Core returned an invalid Skill Lab command")
        if value.get("schemaVersion") != "1.0" or value.get("runId") != run_id:
            raise CoreClientError("unsupported or mismatched Skill Lab command")
        if not isinstance(value.get("repositorySnapshots"), list):
            raise CoreClientError("Skill Lab command contains no repository snapshots")
        return value

    def download(self, path: str) -> bytes:
        response = self._request("GET", path, headers={"accept": "application/octet-stream"})
        return response.content

    def update_progress(
        self,
        command: Mapping[str, Any],
        *,
        status: str,
        progress: int,
        stage: str,
        note: str,
    ) -> None:
        callbacks = _mapping(command.get("callbacks"), "callbacks")
        self._json(
            "POST",
            _string(callbacks.get("progress"), "callbacks.progress"),
            json={
                "status": status,
                "progress": max(0, min(99, int(progress))),
                "stage": stage[:100],
                "note": note[:1000],
            },
        )

    def upload_artifact(
        self,
        command: Mapping[str, Any],
        file_name: str,
        content: bytes,
    ) -> Mapping[str, Any]:
        template = _string(command.get("artifactUploadPath"), "artifactUploadPath")
        path = template.replace("{fileName}", file_name)
        value = self._json(
            "PUT",
            path,
            content=content,
            headers={
                "content-type": "application/octet-stream",
                "x-content-sha256": hashlib.sha256(content).hexdigest(),
            },
        )
        if not isinstance(value, Mapping) or not isinstance(value.get("artifactKey"), str):
            raise CoreClientError("Core returned an invalid artifact receipt")
        return value

    def complete(self, command: Mapping[str, Any], payload: Mapping[str, Any]) -> None:
        callbacks = _mapping(command.get("callbacks"), "callbacks")
        self._json("POST", _string(callbacks.get("complete"), "callbacks.complete"), json=payload)

    def fail(self, run_id: str, error: str) -> None:
        self._json(
            "POST",
            f"/internal/v1/skilllab-runs/{run_id}/fail",
            json={"error": error[:2000]},
        )

    def _json(self, method: str, path: str, **kwargs: Any) -> Any:
        response = self._request(method, path, **kwargs)
        if not response.content:
            return None
        try:
            return response.json()
        except ValueError as error:
            raise CoreClientError(f"Core returned non-JSON for {path}") from error

    def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        normalized = path if path.startswith("/") else f"/{path}"
        try:
            response = self._client.request(method, normalized, **kwargs)
        except httpx.HTTPError as error:
            raise CoreClientError(f"Core request failed for {normalized}: {type(error).__name__}") from error
        if response.is_error:
            message = response.text[:1000].replace("\n", " ")
            raise CoreClientError(f"Core HTTP {response.status_code} for {normalized}: {message}")
        return response


def _mapping(value: Any, name: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise CoreClientError(f"Skill Lab command field {name} must be an object")
    return value


def _string(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise CoreClientError(f"Skill Lab command field {name} must be a string")
    return value
