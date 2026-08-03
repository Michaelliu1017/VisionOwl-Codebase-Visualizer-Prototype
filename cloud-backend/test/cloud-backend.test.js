"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { WebSocket } = require("ws");
const { createCloudApp } = require("../src/app");
const { MemoryStore } = require("../src/db/memory-store");
const { loadConfig } = require("../src/config");

async function fixture(t) {
  let instant = new Date("2026-08-03T00:00:00.000Z");
  const clock = () => new Date(instant);
  const store = new MemoryStore();
  const config = loadConfig({
    store: "memory",
    host: "127.0.0.1",
    port: 0,
    allowedOrigins: "http://127.0.0.1:17300",
  });
  const app = createCloudApp({
    store,
    config,
    clock,
    logger: { error() {} },
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(() => app.close());

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

  async function register(email, displayName) {
    const result = await request("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, displayName, password: "correct-horse-battery" }),
    });
    assert.equal(result.response.status, 201);
    return result.payload;
  }

  return {
    app,
    base,
    clock,
    request,
    register,
    advance(milliseconds) {
      instant = new Date(instant.getTime() + milliseconds);
    },
  };
}

function artifact(projectId) {
  return {
    schemaVersion: "1.0",
    project: { id: projectId, name: "Shared architecture" },
    source: {
      branch: "master",
      commit: "a1b2c3d4e5f678901234567890abcdef12345678",
      generatedAt: "2026-08-03T00:00:00.000Z",
    },
    graph: {
      entities: [
        {
          id: "orders",
          category: "code",
          kind: "module",
          name: "Orders",
          summary: "Creates orders.",
          status: "healthy",
          path: "src/orders.js",
          language: "javascript",
          tags: ["application"],
          metadata: {},
          evidence: [{ file: "src/orders.js", line: 10, symbol: "createOrder" }],
        },
        {
          id: "database",
          category: "data",
          kind: "database",
          name: "PostgreSQL",
          summary: "Stores orders.",
          status: "healthy",
          tags: ["infrastructure"],
          metadata: {},
          evidence: [{ file: "src/database.js", line: 4 }],
        },
      ],
      relations: [
        {
          id: "orders-writes-db",
          source: "orders",
          target: "database",
          type: "writes",
          label: "writes orders",
          status: "healthy",
          directed: true,
          generated: false,
          metadata: {},
          evidence: [{ file: "src/orders.js", line: 18 }],
        },
      ],
      executionFlows: [
        {
          id: "create-order",
          name: "Create order",
          summary: "Writes a new order.",
          entryPoint: "POST /orders",
          featured: true,
          entityIds: ["orders", "database"],
          relationIds: ["orders-writes-db"],
          lanes: ["application", "data"],
        },
      ],
    },
  };
}

test("owner invites members, publishes a graph, and collaborators receive shared state", async (t) => {
  const env = await fixture(t);
  const owner = await env.register("owner@example.com", "Owner");
  const editor = await env.register("editor@example.com", "Editor");
  const viewer = await env.register("viewer@example.com", "Viewer");

  const created = await env.request("/api/projects", {
    token: owner.accessToken,
    method: "POST",
    body: JSON.stringify({ name: "TestRepo", defaultBranch: "master" }),
  });
  assert.equal(created.response.status, 201);
  const projectId = created.payload.id;

  async function inviteAndRedeem(role, session) {
    const invite = await env.request(`/api/projects/${projectId}/invites`, {
      token: owner.accessToken,
      method: "POST",
      body: JSON.stringify({ role }),
    });
    assert.equal(invite.response.status, 201);
    assert.match(invite.payload.token, /^vwo_/);
    const redeemed = await env.request("/api/invites/redeem", {
      token: session.accessToken,
      method: "POST",
      body: JSON.stringify({ token: invite.payload.token }),
    });
    assert.equal(redeemed.response.status, 200);
  }

  await inviteAndRedeem("editor", editor);
  await inviteAndRedeem("viewer", viewer);

  const viewerUpload = await env.request(`/api/projects/${projectId}/graph-versions`, {
    token: viewer.accessToken,
    method: "POST",
    body: JSON.stringify({ artifact: artifact(projectId) }),
  });
  assert.equal(viewerUpload.response.status, 403);

  const uploaded = await env.request(`/api/projects/${projectId}/graph-versions`, {
    token: owner.accessToken,
    method: "POST",
    body: JSON.stringify({
      artifact: artifact(projectId),
      engineVersion: "visionowl-local/0.1.0",
      skillVersion: "understand-anything",
    }),
  });
  assert.equal(uploaded.response.status, 201);
  assert.equal(uploaded.payload.status, "ready");

  const activated = await env.request(
    `/api/projects/${projectId}/graph-versions/${uploaded.payload.id}/activate`,
    { token: owner.accessToken, method: "POST", body: "{}" },
  );
  assert.equal(activated.response.status, 200);
  assert.equal(activated.payload.status, "active");

  const graph = await env.request(`/api/projects/${projectId}/graph/current`, {
    token: viewer.accessToken,
  });
  assert.equal(graph.response.status, 200);
  assert.equal(graph.payload.artifact.graph.entities.length, 2);
  assert.equal(graph.payload.artifact.graph.relations[0].source, "orders");

  const document = await env.request(`/api/projects/${projectId}/documents`, {
    token: editor.accessToken,
    method: "POST",
    body: JSON.stringify({
      scope: "module",
      stableEntityId: "orders",
      provider: "link",
      title: "Order module",
      url: "https://docs.example.com/orders",
    }),
  });
  assert.equal(document.response.status, 201);

  const annotation = await env.request(`/api/projects/${projectId}/annotations`, {
    token: editor.accessToken,
    method: "POST",
    body: JSON.stringify({ stableEntityId: "orders", body: "Review transaction boundaries." }),
  });
  assert.equal(annotation.response.status, 201);
  assert.equal(annotation.payload.author, "Editor");

  const viewerWrite = await env.request(`/api/projects/${projectId}/annotations`, {
    token: viewer.accessToken,
    method: "POST",
    body: JSON.stringify({ stableEntityId: "orders", body: "Should fail" }),
  });
  assert.equal(viewerWrite.response.status, 403);

  const documents = await env.request(`/api/projects/${projectId}/documents`, {
    token: viewer.accessToken,
  });
  const annotations = await env.request(
    `/api/projects/${projectId}/annotations?entityId=orders`,
    { token: viewer.accessToken },
  );
  assert.equal(documents.payload.length, 1);
  assert.equal(annotations.payload.length, 1);
});

test("realtime ticket replays stored events and receives live events", async (t) => {
  const env = await fixture(t);
  const owner = await env.register("live-owner@example.com", "Live Owner");
  const project = await env.request("/api/projects", {
    token: owner.accessToken,
    method: "POST",
    body: JSON.stringify({ name: "Live Project" }),
  });
  const projectId = project.payload.id;

  const ticket = await env.request(`/api/projects/${projectId}/realtime-ticket`, {
    token: owner.accessToken,
    method: "POST",
    body: "{}",
  });
  const websocketUrl = env.base.replace("http://", "ws://");
  const socket = new WebSocket(
    `${websocketUrl}/ws/projects/${projectId}?ticket=${encodeURIComponent(ticket.payload.ticket)}&after=0`,
    { origin: "http://127.0.0.1:17300" },
  );
  t.after(() => socket.close());
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  const received = [];
  socket.on("message", (value) => received.push(JSON.parse(value.toString())));
  const invite = await env.request(`/api/projects/${projectId}/invites`, {
    token: owner.accessToken,
    method: "POST",
    body: JSON.stringify({ role: "viewer" }),
  });
  const collaborator = await env.register("live-viewer@example.com", "Live Viewer");
  await env.request("/api/invites/redeem", {
    token: collaborator.accessToken,
    method: "POST",
    body: JSON.stringify({ token: invite.payload.token }),
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(
    received.some(
      (message) =>
        message.event === "project.event" &&
        message.data.type === "project.member.joined",
    ),
  );
});

test("cloud rejects mismatched, secret-bearing, and wrong-branch graph artifacts", async (t) => {
  const env = await fixture(t);
  const owner = await env.register("secure@example.com", "Secure Owner");
  const project = await env.request("/api/projects", {
    token: owner.accessToken,
    method: "POST",
    body: JSON.stringify({ name: "Secure", defaultBranch: "master" }),
  });
  const projectId = project.payload.id;

  const mismatch = artifact("another-project");
  let result = await env.request(`/api/projects/${projectId}/graph-versions`, {
    token: owner.accessToken,
    method: "POST",
    body: JSON.stringify({ artifact: mismatch }),
  });
  assert.equal(result.response.status, 422);

  const wrongBranch = artifact(projectId);
  wrongBranch.source.branch = "feature/local";
  result = await env.request(`/api/projects/${projectId}/graph-versions`, {
    token: owner.accessToken,
    method: "POST",
    body: JSON.stringify({ artifact: wrongBranch }),
  });
  assert.equal(result.response.status, 409);

  const secret = artifact(projectId);
  secret.graph.entities[0].summary = "token=abcdefghijklmnop";
  result = await env.request(`/api/projects/${projectId}/graph-versions`, {
    token: owner.accessToken,
    method: "POST",
    body: JSON.stringify({ artifact: secret }),
  });
  assert.equal(result.response.status, 422);
});

test("refresh tokens rotate and expired invitations cannot be redeemed", async (t) => {
  const env = await fixture(t);
  const owner = await env.register("rotate@example.com", "Rotate Owner");
  const collaborator = await env.register("late@example.com", "Late User");

  const refreshed = await env.request("/api/auth/refresh", {
    method: "POST",
    body: JSON.stringify({ refreshToken: owner.refreshToken }),
  });
  assert.equal(refreshed.response.status, 200);
  assert.notEqual(refreshed.payload.refreshToken, owner.refreshToken);

  const project = await env.request("/api/projects", {
    token: refreshed.payload.accessToken,
    method: "POST",
    body: JSON.stringify({ name: "Expiring" }),
  });
  const invite = await env.request(`/api/projects/${project.payload.id}/invites`, {
    token: refreshed.payload.accessToken,
    method: "POST",
    body: JSON.stringify({ role: "viewer" }),
  });
  env.advance(8 * 24 * 3600 * 1000);
  const collaboratorRefresh = await env.request("/api/auth/refresh", {
    method: "POST",
    body: JSON.stringify({ refreshToken: collaborator.refreshToken }),
  });
  assert.equal(collaboratorRefresh.response.status, 200);
  const redemption = await env.request("/api/invites/redeem", {
    token: collaboratorRefresh.payload.accessToken,
    method: "POST",
    body: JSON.stringify({ token: invite.payload.token }),
  });
  assert.equal(redemption.response.status, 410);
  assert.equal(redemption.payload.error, "invite_expired");
});
