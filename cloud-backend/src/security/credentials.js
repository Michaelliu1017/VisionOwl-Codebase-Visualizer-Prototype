"use strict";

const { promisify } = require("node:util");
const {
  createHash,
  randomBytes,
  scrypt: scryptCallback,
  timingSafeEqual,
} = require("node:crypto");

const scrypt = promisify(scryptCallback);
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function tokenHash(token) {
  return createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64url"),
    Buffer.from(derived).toString("base64url"),
  ].join("$");
}

async function verifyPassword(password, encoded) {
  const [algorithm, n, r, p, saltValue, hashValue] = String(encoded || "").split("$");
  if (algorithm !== "scrypt" || !saltValue || !hashValue) return false;
  const expected = Buffer.from(hashValue, "base64url");
  const actual = Buffer.from(
    await scrypt(password, Buffer.from(saltValue, "base64url"), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    }),
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

module.exports = { hashPassword, randomToken, tokenHash, verifyPassword };
