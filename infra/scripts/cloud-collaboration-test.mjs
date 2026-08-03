import assert from "node:assert/strict";
import process from "node:process";
import { WebSocket } from "ws";

const base = (process.env.VISIONOWL_CLOUD_URL || "https://114.55.60.94").replace(/\/$/, "");
const runId = Date.now().toString(36);

async function request(path, { token, ...options } = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const payload = await response.json().catch(() => undefined);
  return { response, payload };
}

async function register(role) {
  const result = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      email: `visionowl-smoke-${role}-${runId}@example.com`,
      displayName: `Smoke ${role}`,
      password: "visionowl-deployment-smoke-password",
    }),
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.payload));
  return result.payload;
}

const owner = await register("owner");
const viewer = await register("viewer");

const created = await request("/api/projects", {
  token: owner.accessToken,
  method: "POST",
  body: JSON.stringify({ name: `VisionOwl deployment smoke ${runId}`, defaultBranch: "master" }),
});
assert.equal(created.response.status, 201, JSON.stringify(created.payload));
const projectId = created.payload.id;

const ticket = await request(`/api/projects/${projectId}/realtime-ticket`, {
  token: owner.accessToken,
  method: "POST",
  body: "{}",
});
assert.equal(ticket.response.status, 201, JSON.stringify(ticket.payload));

const socketUrl = base.replace(/^http/, "ws");
const socket = new WebSocket(
  `${socketUrl}/ws/projects/${projectId}?ticket=${encodeURIComponent(ticket.payload.ticket)}&after=0`,
  { origin: "http://127.0.0.1:17300" },
);
await new Promise((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});
const events = [];
socket.on("message", (value) => events.push(JSON.parse(value.toString())));

const invite = await request(`/api/projects/${projectId}/invites`, {
  token: owner.accessToken,
  method: "POST",
  body: JSON.stringify({ role: "viewer" }),
});
assert.equal(invite.response.status, 201, JSON.stringify(invite.payload));
assert.match(invite.payload.token, /^vwo_/);

const redeemed = await request("/api/invites/redeem", {
  token: viewer.accessToken,
  method: "POST",
  body: JSON.stringify({ token: invite.payload.token }),
});
assert.equal(redeemed.response.status, 200, JSON.stringify(redeemed.payload));

const artifact = {
  schemaVersion: "1.0",
  project: { id: projectId, name: "Deployment smoke graph" },
  source: {
    branch: "master",
    commit: "a1b2c3d4e5f678901234567890abcdef12345678",
    generatedAt: new Date().toISOString(),
  },
  graph: {
    entities: [
      {
        id: "app",
        category: "code",
        kind: "module",
        name: "Application",
        summary: "Deployment smoke application module.",
        status: "healthy",
        path: "src/app.js",
        language: "javascript",
        tags: ["application"],
        metadata: {},
        evidence: [{ file: "src/app.js", line: 1 }],
      },
    ],
    relations: [],
    executionFlows: [],
  },
};

const uploaded = await request(`/api/projects/${projectId}/graph-versions`, {
  token: owner.accessToken,
  method: "POST",
  body: JSON.stringify({
    artifact,
    engineVersion: "deployment-smoke/1.0.0",
    skillVersion: "understand-anything",
  }),
});
assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.payload));

const activated = await request(
  `/api/projects/${projectId}/graph-versions/${uploaded.payload.id}/activate`,
  { token: owner.accessToken, method: "POST", body: "{}" },
);
assert.equal(activated.response.status, 200, JSON.stringify(activated.payload));

const graph = await request(`/api/projects/${projectId}/graph/current`, {
  token: viewer.accessToken,
});
assert.equal(graph.response.status, 200, JSON.stringify(graph.payload));
assert.equal(graph.payload.artifact.graph.entities[0].id, "app");

await new Promise((resolve) => setTimeout(resolve, 250));
assert.ok(
  events.some(
    (message) =>
      message.event === "project.event" && message.data.type === "project.member.joined",
  ),
  `Expected project.member.joined event, received ${JSON.stringify(events)}`,
);

socket.close();
console.log(
  JSON.stringify(
    {
      status: "ok",
      base,
      projectId,
      graphVersionId: uploaded.payload.id,
      inviteRole: invite.payload.role,
      realtimeEvent: "project.member.joined",
    },
    null,
    2,
  ),
);
