import assert from "node:assert/strict";
import test from "node:test";
import { extractDwsJson, parseDwsAuthorizationOutput } from "./dingtalk";

test("parseDwsAuthorizationOutput extracts complete URL and user code", () => {
  const parsed = parseDwsAuthorizationOutput(`
    链接: https://login.dingtalk.com/device
    授权码: ABCD-EFGH
    https://login.dingtalk.com/device?user_code=ABCD-EFGH
  `);
  assert.equal(parsed.userCode, "ABCD-EFGH");
  assert.equal(parsed.authorizationUrl, "https://login.dingtalk.com/device?user_code=ABCD-EFGH");
});

test("extractDwsJson accepts progress before final JSON", () => {
  const parsed = extractDwsJson(`[INFO] done\n{
    "success": true,
    "corp_id": "corp-1",
    "user_id": "user-1"
  }`);
  assert.equal(parsed?.success, true);
  assert.equal(parsed?.corp_id, "corp-1");
});
