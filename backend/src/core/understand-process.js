"use strict";

const { spawn } = require("node:child_process");

function runProcess({
  command,
  args = [],
  cwd,
  env = {},
  timeoutMs = 5 * 60 * 1000,
  label = command,
  onStderr,
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer;

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      callback();
    };

    if (timeoutMs > 0) {
      killTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGTERM");
        finish(() =>
          reject(
            new Error(
              `${label} timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`,
            ),
          ),
        );
      }, timeoutMs);
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      onStderr?.(text);
    });
    child.on("error", (error) => {
      finish(() => reject(new Error(`${label} failed to start: ${error.message}`)));
    });
    child.on("close", (code, signal) => {
      finish(() => {
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        const detail = stderr.trim() || stdout.trim();
        reject(
          new Error(
            `${label} exited with ${signal ? `signal ${signal}` : `status ${code}`}${
              detail ? `: ${detail}` : ""
            }`,
          ),
        );
      });
    });
  });
}

module.exports = {
  runProcess,
};
