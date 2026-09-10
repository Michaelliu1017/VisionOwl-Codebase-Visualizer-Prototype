import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AnalysisPacket } from "./v2/analysisPackets";
import {
  adaptiveTaskCount,
  buildAssignments,
  buildModuleRepairPrompt,
  buildQoderInvocationArgs,
  buildSourceContext,
  inspectAgentPayload,
  mapConcurrent,
  moduleResultCandidates,
  normalizeModuleResult,
  parseAgentPayload,
} from "./v2/agentOrchestrator";

function packet(
  id: string,
  outgoingModuleIds: string[] = [],
  priority: AnalysisPacket["priority"] = "normal",
): AnalysisPacket {
  const moduleId = `module:${id}`;
  return {
    packetId: `packet:${id}`,
    packetHash: `hash:${id}`,
    projectId: "project-1",
    repositoryId: "repository-1",
    commitSha: "abc1234",
    module: { id: moduleId, name: id, path: `packages/${id}` },
    entryFactIds: [],
    publicSymbolIds: [],
    relatedFactIds: [`fact:${id}`],
    incomingModuleIds: [],
    outgoingModuleIds,
    interfaceIds: [],
    resourceIds: [],
    diagnosticIds: [],
    allowedFiles: [`packages/${id}/index.ts`],
    evidence: [{
      factId: `fact:${id}`,
      file: `packages/${id}/index.ts`,
      startLine: 1,
      endLine: 4,
      excerptHash: `excerpt:${id}`,
    }],
    questions: [],
    budget: { maxFiles: 12, maxSourceBytes: 60_000, maxTurns: 1 },
    priority,
  };
}

test("module assignments cover every packet exactly once within the task limit", () => {
  const packets = [
    packet("api", ["module:orders"], "changed"),
    packet("orders", ["module:database"]),
    packet("database"),
    packet("worker", ["module:orders"]),
    packet("web", ["module:api"]),
  ];
  const assignments = buildAssignments(packets, 3);
  const assignedIds = assignments.flatMap((item) => item.packets.map((value) => value.packetId));

  assert.equal(assignments.length, 3);
  assert.deepEqual([...assignedIds].sort(), packets.map((item) => item.packetId).sort());
  assert.equal(new Set(assignedIds).size, packets.length);
  assert.ok(assignments.some((item) =>
    item.packets.some((value) => value.module.id === "module:api") &&
    item.packets.some((value) => value.module.id === "module:orders"),
  ));
});

test("adaptive orchestration uses one agent for normal repos and bounds large repos", () => {
  const options = {
    singleAgentMaxPackets: 8,
    maxAgents: 4,
    packetsPerAgent: 5,
  };

  assert.equal(adaptiveTaskCount(0, options), 0);
  assert.equal(adaptiveTaskCount(8, options), 1);
  assert.equal(adaptiveTaskCount(9, options), 2);
  assert.equal(adaptiveTaskCount(17, options), 4);
  assert.equal(adaptiveTaskCount(80, options), 4);
});

test("module result normalization rejects foreign files and ungrounded operations", () => {
  const target = packet("orders");
  const result = normalizeModuleResult({
    packetId: target.packetId,
    moduleSummary: "处理订单创建与查询。",
    responsibilities: ["创建订单", "创建订单"],
    interfaces: ["POST /orders"],
    dependencies: ["orders -> database"],
    risks: ["需要幂等保护"],
    evidence: [
      { file: "packages/orders/index.ts", startLine: 1, endLine: 3, factId: "fact:orders" },
      { file: "../../secret.txt", startLine: 1, endLine: 2 },
    ],
    proposedOperations: [
      {
        operationId: "grounded",
        op: "update_summary",
        evidence: [{ file: "packages/orders/index.ts", startLine: 1, endLine: 3 }],
      },
      {
        operationId: "ungrounded",
        op: "add_edge",
        evidence: [{ file: "outside.ts", startLine: 1, endLine: 3 }],
      },
    ],
  }, target);

  assert.ok(result);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0]?.factId, "fact:orders");
  assert.deepEqual(result.responsibilities, ["创建订单"]);
  assert.deepEqual(result.proposedOperations.map((item) => item.operationId), ["grounded"]);
});

test("Qoder envelope parsing extracts structured payload and credits", () => {
  const parsed = parseAgentPayload(JSON.stringify({
    credits: 1.25,
    result: "```json\n{\"results\":[{\"packetId\":\"packet:api\"}]}\n```",
  }));

  assert.equal(parsed.credits, 1.25);
  assert.deepEqual(parsed.payload, { results: [{ packetId: "packet:api" }] });
});

test("single-packet model output is accepted without a results wrapper", () => {
  const direct = {
    packetId: "packet:api",
    moduleSummary: "API module",
  };
  assert.deepEqual(moduleResultCandidates(direct), [direct]);
  assert.deepEqual(moduleResultCandidates({ result: direct }), [direct]);
  assert.deepEqual(moduleResultCandidates({ results: [direct] }), [direct]);
  assert.deepEqual(moduleResultCandidates({ data: { output: { analysis: direct } } }), [direct]);
  assert.deepEqual(parseAgentPayload(JSON.stringify(direct)).payload, direct);
});

test("nested single-module output can be normalized after restoring its packet id", () => {
  const target = packet("api");
  const [candidate] = moduleResultCandidates({
    output: {
      moduleSummary: "Provides the API boundary.",
      responsibilities: ["Handle requests"],
      evidence: [{ file: "packages/api/index.ts", startLine: 1, endLine: 2 }],
    },
  });
  const object = candidate as Record<string, unknown>;
  const normalized = normalizeModuleResult({ ...object, packetId: target.packetId }, target);
  assert.equal(normalized?.moduleSummary, "Provides the API boundary.");
});

test("concurrent mapper preserves order and respects the concurrency limit", async () => {
  let active = 0;
  let peak = 0;
  const output = await mapConcurrent([40, 5, 20, 10], 2, async (delay, index) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active -= 1;
    return `result-${index}`;
  });

  assert.equal(peak, 2);
  assert.deepEqual(output, ["result-0", "result-1", "result-2", "result-3"]);
});

test("Qoder invocation passes large module context as an attachment", () => {
  const promptFile = "/tmp/visionowl-assignment/module-context.md";
  const args = buildQoderInvocationArgs({
    model: "Performance",
    cwd: "/workspace/repo",
    maxOutputTokens: 4_000,
    configDir: "/tmp/visionowl-assignment",
    promptFile,
  });

  assert.equal(args[args.indexOf("--attachment") + 1], promptFile);
  assert.equal(args[args.indexOf("-m") + 1], "Performance");
  assert.ok(args.join(" ").length < 1_000);
  assert.ok(!args.some((value) => value.length > 1_000));
});

test("source context reads evidence windows instead of whole files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "visionowl-source-context-"));
  const target = packet("orders");
  target.evidence = [{
    factId: "fact:orders",
    file: "packages/orders/index.ts",
    startLine: 150,
    endLine: 151,
    excerptHash: "excerpt:orders",
  }];
  try {
    await fs.mkdir(path.join(root, "packages/orders"), { recursive: true });
    await fs.writeFile(
      path.join(root, "packages/orders/index.ts"),
      Array.from({ length: 240 }, (_, index) => `line-${index + 1}`).join("\n"),
    );
    const context = await buildSourceContext(root, [target], {
      maxBytes: 4_000,
      maxFiles: 1,
      contextLines: 2,
    });

    assert.match(context, /148\| line-148/);
    assert.match(context, /153\| line-153/);
    assert.doesNotMatch(context, /1\| line-1(?:\n|$)/);
    assert.doesNotMatch(context, /200\| line-200/);
    assert.ok(Buffer.byteLength(context, "utf8") <= 4_000);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("payload diagnostics never persist the raw model answer", () => {
  const inspected = inspectAgentPayload("not-json token=do-not-persist");
  const serialized = JSON.stringify(inspected.diagnostics);

  assert.equal(inspected.payload, undefined);
  assert.equal(inspected.diagnostics.parseStage, "no_json_object");
  assert.equal(inspected.diagnostics.parseErrorCode, "missing_json_object");
  assert.doesNotMatch(serialized, /do-not-persist/);
});

test("repair prompt contains only the failed output contract, not source context", () => {
  const target = packet("api");
  const prompt = buildModuleRepairPrompt(
    "assignment-001",
    [target],
    "API module handles incoming requests but returned prose.",
  );

  assert.match(prompt, /JSON 结构修复器/);
  assert.match(prompt, /packet:api/);
  assert.match(prompt, /FIRST_OUTPUT/);
  assert.doesNotMatch(prompt, /SOURCE_CONTEXT|FACT_CONTEXT|packages\/api\/index\.ts/);
  assert.match(prompt, /禁止读取源码、重新分析、补充新事实/);
});
