# VisionOwl Local Stack Reference

## Process Model

| Process | Address | State | Purpose |
|---|---|---|---|
| Cloud Backend | `127.0.0.1:17800` | Memory for local deployment | Accounts, Projects, invitations, sanitized graphs, shared documents and annotations |
| Electron main process | Desktop application | OS process | Starts the Local Agent, stores the cloud session securely, and exposes restricted IPC |
| Local Agent API | `127.0.0.1:17300` | SQLite in Electron user data | Reads repositories selected locally by the user, analyzes source, runs Agent chat and document automation |
| React renderer | Loaded from Local Agent | Browser sandbox | Displays projects, graphs, documents, annotations, progress, and Agent chat |

The source repository is never sent to the Cloud Backend. The Local Agent generates a sanitized graph artifact and uploads only that artifact to the shared Project.

## Startup Order

1. Start the memory Cloud Backend.
2. Wait for `GET http://127.0.0.1:17800/api/health` to return `service=visionowl-cloud`.
3. Start Electron with `VISIONOWL_CLOUD_API_URL=http://127.0.0.1:17800`.
4. Electron starts the Local Agent with a random local API token.
5. The renderer connects to the Cloud Backend for team state and to the Local Agent for source-bound operations.

The bundled `start-local.sh` performs this order and owns only the Cloud Backend process that it starts.

## Important Environment Variables

| Variable | Local value | Reason |
|---|---|---|
| `VISIONOWL_CLOUD_STORE` | `memory` | Avoid PostgreSQL as a first-run dependency |
| `VISIONOWL_CLOUD_API_URL` | `http://127.0.0.1:17800` | Connect Electron to the local Cloud Backend |
| `VISIONOWL_CODEX_ENABLED` | `true` or `false` | Enable semantic Agent work or deterministic-only mode |
| `VISIONOWL_UNDERSTAND_SKILL_PATH` | Absolute `SKILL.md` path | Resolve the Understand Anything engine |
| `DWS_BIN` | Optional absolute executable | Override DWS auto-detection |

## Browser Fallback

Use this only when Electron cannot run, such as a headless Linux host.

1. Start Cloud Backend with `VISIONOWL_CLOUD_STORE=memory HOST=127.0.0.1 PORT=17800 npm run start:cloud`.
2. Start the development UI and Local Agent with `npm run dev`.
3. Open `http://127.0.0.1:4173`.

The fallback validates services and most UI workflows, but does not provide Electron's native repository picker, encrypted desktop cloud session, or desktop-managed DWS OAuth IPC.

## Common Failures

| Symptom | Likely cause | Action |
|---|---|---|
| Cloud login page cannot connect | Cloud Backend is not running on 17800 | Check `/api/health` and the Cloud Backend terminal |
| Local repository is rejected | The selected path is not a Git repository, is unavailable, or the checked-out branch changed | Select the repository root or switch back to the Project branch |
| Analysis stops before scanning | Understand Anything skill cannot be resolved | Set `VISIONOWL_UNDERSTAND_SKILL_PATH` to the official skill |
| Agent features fall back or fail | Codex executable is unavailable | Configure `CODEX_BIN` or use deterministic mode |
| DingTalk document action requests login | DWS is logged out or a different DWS binary is active | Let the desktop OAuth recovery flow open the login page |
| Port 17300 is occupied | Another VisionOwl desktop instance is running | Close that instance; do not kill arbitrary processes |
| Port 17800 is occupied but health check fails | Another service owns the port | Stop and report the conflict |

## Persistent Local Development

The memory Cloud Backend intentionally loses accounts and team data when stopped. Use PostgreSQL only when persistence is explicitly required. In that case, set `DATABASE_URL`, run `npm run migrate:cloud`, and start `npm run start:cloud`; do not fold database provisioning into the first-run Skill.
