import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import process from "node:process";
import { printTerminalBanner } from "@visionowl/pybanner-runtime";

const root = new URL("../", import.meta.url).pathname;
const bannerScript = new URL("./banner.py", import.meta.url).pathname;

printTerminalBanner({ root, bannerScript });

const localApiToken = randomBytes(32).toString("base64url");
const processes = [
  spawn("npm", ["run", "dev", "--workspace", "@visionowl/api"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, VISIONOWL_LOCAL_TOKEN: localApiToken },
  }),
  spawn("npm", ["run", "dev", "--workspace", "@visionowl/web"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, VITE_VISIONOWL_LOCAL_TOKEN: localApiToken },
  }),
];

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of processes) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 300).unref();
}

for (const child of processes) {
  child.on("exit", (code) => {
    if (!stopping && code) stop(code);
  });
}

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
