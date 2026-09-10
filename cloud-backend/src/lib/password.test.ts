import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, verifyPassword } from "./password";

test("scrypt 哈希可校验且格式带参数", async () => {
  const stored = await hashPassword("demo1234");
  assert.match(stored, /^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.equal(await verifyPassword("demo1234", stored), true);
  assert.equal(await verifyPassword("demo12345", stored), false);
});

test("同一口令两次哈希不同（随机盐）", async () => {
  const a = await hashPassword("demo1234");
  const b = await hashPassword("demo1234");
  assert.notEqual(a, b);
  assert.equal(await verifyPassword("demo1234", a), true);
  assert.equal(await verifyPassword("demo1234", b), true);
});

test("非法存储格式一律判否，不抛异常", async () => {
  for (const bad of ["", "plain", "scrypt$1$2$3", "bcrypt$x$y$z$w$v"]) {
    assert.equal(await verifyPassword("demo1234", bad), false);
  }
});
