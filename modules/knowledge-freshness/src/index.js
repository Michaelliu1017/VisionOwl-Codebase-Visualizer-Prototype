const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function assessKnowledgeFreshness({
  sourceCommitSha,
  currentCommitSha,
  generatedAt,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  now = Date.now(),
}) {
  const reasons = [];

  if (!sourceCommitSha || !currentCommitSha || sourceCommitSha !== currentCommitSha) {
    reasons.push("commit_changed");
  }

  const generatedAtMs = Date.parse(generatedAt);
  const ageMs = Number.isNaN(generatedAtMs) ? null : Math.max(0, now - generatedAtMs);

  if (ageMs === null) {
    reasons.push("invalid_generation_time");
  } else if (ageMs > maxAgeMs) {
    reasons.push("age_exceeded");
  }

  return {
    status: reasons.length === 0 ? "fresh" : "stale",
    reasons,
    ageMs,
  };
}
