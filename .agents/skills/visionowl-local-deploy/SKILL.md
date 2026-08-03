---
name: visionowl-local-deploy
description: Install, configure, verify, launch, or troubleshoot a cloned VisionOwl repository as a secure local desktop stack. Use when an agent is asked to set up VisionOwl after cloning from GitHub, run the Electron application locally, start the local Cloud Backend, authorize a repository for analysis, check prerequisites, or diagnose first-run failures. Supports macOS and Linux development; keeps source access loopback-only and treats Codex, Understand Anything, and DingTalk DWS as explicit integrations.
---

# Deploy VisionOwl Locally

Deploy a complete local development stack with two processes:

1. Memory-backed Cloud Backend on `127.0.0.1:17800`.
2. Electron desktop app, which starts its private Local Agent API on `127.0.0.1:17300`.

Use the bundled scripts instead of reconstructing the startup sequence. Read [local-stack.md](references/local-stack.md) only when diagnosing ports, integrations, or security boundaries.

## Guardrails

- Keep both APIs on loopback. Never change the Local Agent host to `0.0.0.0`.
- Let the user select a local Git repository in Electron after launch. Never accept `/` or the user home directory as an analysis target.
- Do not commit `.env`, tokens, DWS state, SQLite files, generated `.ua` data, or credentials.
- Do not require PostgreSQL for a first local run. The bundled launcher uses the memory store.
- Do not run remote install scripts without reviewing them and obtaining approval.
- Do not log cloud sessions, DWS tokens, DingTalk credentials, or repository source.
- Preserve user changes. Never reset or clean a dirty worktree as part of deployment.

## Workflow

### 1. Confirm the workspace

- Run from the cloned VisionOwl repository root, verified by `package.json` containing `"name": "visionowl"`.
- Do not require a repository path during deployment. The user selects a repository from Electron after the application opens.

### 2. Run the read-only preflight

Run `node .agents/skills/visionowl-local-deploy/scripts/preflight.mjs`.

Treat these as hard requirements:

- Node.js 22.5 or newer.
- npm, Git, and Python 3.10 or newer.
- A valid VisionOwl workspace.

Treat these as optional integrations:

- Understand Anything: required only when analyzing a repository.
- Codex: required for semantic enrichment, document generation, and Agent chat; deterministic analysis can run without it.
- DWS: required only for DingTalk document creation and updates.

Report every failed check before changing the machine. Install missing system software only after user approval.

### 3. Install repository dependencies

- Use `npm ci` when `package-lock.json` is present.
- If `npm ci` fails because the lockfile is inconsistent, inspect the cause and ask before running `npm install`, because it can modify the lockfile.
- Do not globally install project packages.

### 4. Resolve Understand Anything

Skip this step only for UI-only smoke tests or when using `--deterministic`.

Prefer, in order:

1. Existing `VISIONOWL_UNDERSTAND_SKILL_PATH`.
2. Existing `~/.agents/skills/understand/SKILL.md` or `~/.codex/skills/understand/SKILL.md`.
3. An existing official Understand-Anything checkout.
4. With user approval, clone `https://github.com/Egonex-AI/Understand-Anything` to a user-owned dependency directory and set `VISIONOWL_UNDERSTAND_SKILL_PATH` to `understand-anything-plugin/skills/understand/SKILL.md`.

Do not silently substitute VisionOwl's repository-understanding skill; it is an enrichment policy, not the deterministic Understand Anything engine.

### 5. Verify before launch

Run `npm test`. Do not launch the desktop app after a failing test unless the user explicitly chooses a diagnostic run. Summarize the failing workspace and first actionable error.

### 6. Launch the full local stack

Run `.agents/skills/visionowl-local-deploy/scripts/start-local.sh` in a persistent terminal session.

Options:

- Add `--deterministic` when Codex is unavailable; this sets `VISIONOWL_CODEX_ENABLED=false`.
- Set `VISIONOWL_UNDERSTAND_SKILL_PATH` before launch when the skill is in a nonstandard location.

The launcher must:

- Reject an occupied Local Agent port instead of killing another process.
- Reuse an existing healthy VisionOwl Cloud Backend on port 17800, otherwise start one.
- Build and open Electron.
- Stop the Cloud Backend it created when Electron exits.

Launching Electron is a GUI action. Request the environment's required approval immediately before running the launcher.

### 7. Verify the running stack

- Confirm the launcher reports a healthy Cloud Backend.
- Confirm Electron opens and the Local Agent reports `http://127.0.0.1:17300` in its terminal output.
- Register a local test account or sign in to an existing local-memory account.
- Create a Project and select any accessible local Git repository. VisionOwl validates the selected path and current branch before analysis.
- For a lightweight smoke test, verify repository selection and project creation. Do not start a potentially expensive full analysis without user approval.
- If a document operation reports `dws_auth_required`, verify that VisionOwl opens the DingTalk OAuth page and retries after the user completes authorization. Never perform the OAuth grant for the user.

## Failure Handling

- If port 17300 is occupied, ask the user to close the existing VisionOwl instance; do not kill unknown processes.
- If port 17800 serves another application, stop and report the conflict.
- If Electron cannot open in a headless Linux environment, use the browser fallback in [local-stack.md](references/local-stack.md) for service validation; explain that native repository selection requires Electron.
- If analysis says Understand Anything is missing, resolve the exact `SKILL.md` path and restart the app with `VISIONOWL_UNDERSTAND_SKILL_PATH`.
- If DWS is absent, keep the rest of VisionOwl running and mark DingTalk automation unavailable.

## Completion Report

Report:

- VisionOwl repository and commit.
- Selected target repository and branch, if the user bound one after launch.
- Node, npm, Git, and Python versions.
- Test and build results.
- Local Cloud and Local Agent endpoints.
- Whether Understand Anything, Codex, and DWS are available.
- Which long-running session contains the app and how to stop it.

Never print credentials or session tokens.
