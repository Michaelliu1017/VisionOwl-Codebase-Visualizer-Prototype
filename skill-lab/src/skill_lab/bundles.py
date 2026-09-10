from __future__ import annotations

import hashlib
import io
import json
import re
import stat
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Dict, Mapping, Tuple


_SKILL_PATH = re.compile(r"^skills/[^/]+/SKILL\.md$")


class BundleError(ValueError):
    pass


@dataclass(frozen=True)
class SkillBundle:
    files: Mapping[str, bytes]
    manifest: Mapping[str, Any]

    def skills(self) -> Tuple[Tuple[str, str], ...]:
        values = []
        for path, content in sorted(self.files.items()):
            if _SKILL_PATH.fullmatch(path):
                values.append((path, content.decode("utf-8")))
        return tuple(values)

    def evaluation_dataset(self) -> Mapping[str, Any]:
        content = self.files.get("evaluation/dataset.json")
        if content is None:
            raise BundleError("Skill bundle is missing evaluation/dataset.json")
        try:
            value = json.loads(content)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise BundleError("evaluation/dataset.json is invalid") from error
        if not isinstance(value, Mapping):
            raise BundleError("evaluation dataset must be an object")
        if value.get("usable") is False:
            warnings = value.get("warnings")
            note = "; ".join(str(item) for item in warnings) if isinstance(warnings, list) else ""
            raise BundleError(f"evaluation dataset is not usable{': ' + note if note else ''}")
        return value


def load_skill_bundle(content: bytes) -> SkillBundle:
    files = read_zip(content)
    raw_manifest = files.pop("manifest.json", None)
    if raw_manifest is None:
        raise BundleError("Skill bundle is missing manifest.json")
    try:
        manifest = json.loads(raw_manifest)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BundleError("Skill bundle manifest is invalid") from error
    if not isinstance(manifest, Mapping) or manifest.get("kind") != "skills":
        raise BundleError("Skill bundle manifest kind must be skills")
    if not any(_SKILL_PATH.fullmatch(path) for path in files):
        raise BundleError("Skill bundle contains no skills/*/SKILL.md")
    return SkillBundle(files=files, manifest=manifest)


def read_zip(content: bytes, *, max_files: int = 5000, max_bytes: int = 100_000_000) -> Dict[str, bytes]:
    result: Dict[str, bytes] = {}
    total = 0
    try:
        archive = zipfile.ZipFile(io.BytesIO(content), "r")
    except zipfile.BadZipFile as error:
        raise BundleError("input is not a valid ZIP archive") from error
    with archive:
        members = archive.infolist()
        if len(members) > max_files:
            raise BundleError("ZIP archive contains too many files")
        for member in members:
            if member.is_dir():
                continue
            path = safe_path(member.filename)
            mode = member.external_attr >> 16
            if stat.S_ISLNK(mode):
                raise BundleError("ZIP archive links are not allowed")
            total += member.file_size
            if total > max_bytes:
                raise BundleError("ZIP archive exceeds the uncompressed size limit")
            if path in result:
                raise BundleError(f"ZIP archive contains duplicate path {path}")
            result[path] = archive.read(member)
    return result


def extract_github_archive(content: bytes, destination: Path) -> Path:
    files = read_zip(content)
    if not files:
        raise BundleError("repository archive is empty")
    roots = {PurePosixPath(path).parts[0] for path in files}
    strip_root = next(iter(roots)) if len(roots) == 1 else None
    destination.mkdir(parents=True, exist_ok=True)
    for path, body in files.items():
        parts = PurePosixPath(path).parts
        relative = PurePosixPath(*parts[1:]) if strip_root else PurePosixPath(*parts)
        if not relative.parts:
            continue
        target = destination.joinpath(*relative.parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
    return destination


def build_zip(files: Mapping[str, bytes], manifest: bytes) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path, content in sorted({**files, "manifest.json": manifest}.items()):
            safe = safe_path(path)
            info = zipfile.ZipInfo(safe, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, content)
    return output.getvalue()


def safe_path(value: str) -> str:
    path = PurePosixPath(value)
    if path.is_absolute() or not path.parts or ".." in path.parts or "" in path.parts:
        raise BundleError(f"unsafe archive path: {value}")
    normalized = path.as_posix()
    if normalized.startswith("./"):
        normalized = normalized[2:]
    return normalized


def sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()
