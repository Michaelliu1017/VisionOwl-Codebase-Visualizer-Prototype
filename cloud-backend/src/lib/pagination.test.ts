import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "./errors";
import { buildPage, decodeCursor, encodeCursor, parseLimit } from "./pagination";

test("cursor 编解码往返一致且对客户端不透明", () => {
  const c = { createdAt: "2026-08-04T04:00:00.000Z", id: "11111111-1111-4111-8111-111111111111" };
  const raw = encodeCursor(c);
  assert.notEqual(raw, `${c.createdAt}|${c.id}`); // 不是明文
  assert.deepEqual(decodeCursor(raw), c);
});

test("空 cursor 返回 null，非法 cursor 报 400", () => {
  assert.equal(decodeCursor(undefined), null);
  assert.equal(decodeCursor(""), null);
  assert.throws(() => decodeCursor(Buffer.from("garbage").toString("base64url")), (err: unknown) => {
    assert.ok(err instanceof AppError);
    assert.equal(err.code, "VALIDATION_FAILED");
    return true;
  });
});

test("limit 校验边界", () => {
  assert.equal(parseLimit(undefined), 20);
  assert.equal(parseLimit("5"), 5);
  assert.equal(parseLimit(100), 100);
  for (const bad of ["0", "101", "abc", "-1", "1.5"]) {
    assert.throws(() => parseLimit(bad), AppError);
  }
});

test("buildPage 多查一条时给出 nextCursor", () => {
  const rows = Array.from({ length: 3 }, (_, i) => ({
    id: `0000000${i}-0000-4000-8000-000000000000`,
    createdAt: `2026-08-0${i + 1}T00:00:00.000Z`,
  }));
  const full = buildPage(rows, 2);
  assert.equal(full.items.length, 2);
  assert.ok(full.nextCursor);
  assert.deepEqual(decodeCursor(full.nextCursor), {
    createdAt: rows[1]!.createdAt,
    id: rows[1]!.id,
  });

  const partial = buildPage(rows.slice(0, 2), 2);
  assert.equal(partial.nextCursor, null);
});
