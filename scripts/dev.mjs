import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import process from "node:process";

const root = new URL("../", import.meta.url).pathname;
const bannerScript = new URL("./banner.py", import.meta.url).pathname;

function printBanner() {
  const candidates = [
    process.env.PYTHON_BIN,
    `${root}.venv/bin/python`,
    "python3.13",
    "python3.12",
    "python3.11",
    "python3.10",
    "python3",
  ].filter(Boolean);

  for (const python of [...new Set(candidates)]) {
    const result = spawnSync(python, [bannerScript], {
      cwd: root,
      encoding: "utf8",
    });
    if (result.status === 0) {
      process.stdout.write(result.stdout);
      return;
    }
  }

  console.warn(
    "VisionOwl banner unavailable. Install Python dependencies with: .venv/bin/python -m pip install -r requirements.txt",
  );
}

printBanner();

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
