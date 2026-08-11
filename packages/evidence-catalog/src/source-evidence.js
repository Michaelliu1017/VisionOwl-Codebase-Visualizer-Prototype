function requiredText(value, field) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new TypeError(`${field} is required`);
  }
  return normalized;
}

export function createEvidenceRecord(input) {
  const repository = requiredText(input?.repository, "repository");
  const commit = requiredText(input?.commit, "commit");
  const path = requiredText(input?.path, "path").replace(/^\.\//, "");
  const line = Number(input?.line);

  if (!Number.isInteger(line) || line < 1) {
    throw new TypeError("line must be a positive integer");
  }

  return {
    id: `${repository}@${commit}:${path}:${line}`,
    repository,
    commit,
    path,
    line,
  };
}
