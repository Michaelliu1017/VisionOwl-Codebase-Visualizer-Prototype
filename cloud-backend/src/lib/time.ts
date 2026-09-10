/** 时间统一 ISO 8601 UTC 字符串（契约 §3），例：2026-08-04T12:00:00.000Z */
export function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** 必有值的时间字段（created_at 等 NOT NULL 列） */
export function isoReq(value: Date | string): string {
  return iso(value) ?? new Date(0).toISOString();
}

export const nowIso = (): string => new Date().toISOString();
