import { spawn } from "node:child_process";
import process from "node:process";

const root = new URL("../", import.meta.url).pathname;
const processes = [
  spawn("npm", ["run", "dev", "--workspace", "@visionowl/api"], {
    cwd: root,
    stdio: "inherit",
  }),
  spawn("npm", ["run", "dev", "--workspace", "@visionowl/web"], {
    cwd: root,
    stdio: "inherit",
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
