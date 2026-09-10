from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any, Mapping, Optional

from .artifacts import LocalArtifactStore
from .models import utc_now


class FileOutbox:
    """Stores versioned events until a future transport publishes them."""

    def __init__(self, root: Path) -> None:
        self.store = LocalArtifactStore(root)

    def publish(
        self,
        event_type: str,
        *,
        project_id: str,
        skill_id: str,
        experiment_id: str,
        status: str,
        artifact_refs: Optional[Mapping[str, str]] = None,
        payload: Optional[Mapping[str, Any]] = None,
    ) -> str:
        event_id = str(uuid.uuid4())
        event = {
            "schemaVersion": "skill-lab-event.v1",
            "eventId": event_id,
            "eventType": event_type,
            "occurredAt": utc_now(),
            "projectId": project_id,
            "skillId": skill_id,
            "experimentId": experiment_id,
            "status": status,
            "artifactRefs": dict(artifact_refs or {}),
            "payload": dict(payload or {}),
        }
        self.store.write_json(experiment_id, f"{event_id}.json", event)
        return event_id

