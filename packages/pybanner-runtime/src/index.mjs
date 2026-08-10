import { spawnSync } from "node:child_process";

export const PYBANNER_REPOSITORY = "https://github.com/Michaelliu1017/PyBanner";

export function printTerminalBanner({ root, bannerScript }) {
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
      return true;
    }
  }

  console.warn(
    `VisionOwl banner from ${PYBANNER_REPOSITORY} is unavailable. ` +
      "Install it with: .venv/bin/python -m pip install -r requirements.txt",
  );
  return false;
}
