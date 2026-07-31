"use strict";

const path = require("node:path");

const FILE_TYPE_BY_CATEGORY = {
  code: "file",
  config: "config",
  docs: "document",
  script: "file",
  markup: "file",
};

function nodeTypeForFile(file) {
  if (FILE_TYPE_BY_CATEGORY[file.fileCategory]) {
    return FILE_TYPE_BY_CATEGORY[file.fileCategory];
  }
  if (file.fileCategory === "infra") {
    if (
      /(^|\/)(\.github\/workflows|\.circleci)\//.test(file.path) ||
      /(^|\/)(Jenkinsfile|\.gitlab-ci\.ya?ml)$/i.test(file.path)
    ) {
      return "pipeline";
    }
    if (/\.(tf|tfvars)$/i.test(file.path) || /(^|\/)Vagrantfile$/i.test(file.path)) {
      return "resource";
    }
    return "service";
  }
  if (file.fileCategory === "data") {
    if (/\.(graphql|gql|proto|prisma)$/i.test(file.path)) return "schema";
    if (/openapi|swagger/i.test(file.path)) return "endpoint";
    if (/\.sql$/i.test(file.path)) return "table";
    return "schema";
  }
  return "file";
}

function fileNodeId(file) {
  return `${nodeTypeForFile(file)}:${file.path}`;
}

function complexityFor(result, file) {
  const lines = result?.nonEmptyLines ?? file.sizeLines ?? 0;
  const definitions =
    (result?.functions?.length || 0) +
    (result?.classes?.length || 0) +
    (result?.definitions?.length || 0) +
    (result?.services?.length || 0) +
    (result?.endpoints?.length || 0) +
    (result?.steps?.length || 0) +
    (result?.resources?.length || 0);
  if (lines > 200 || definitions > 20) return "complex";
  if (lines >= 50 || definitions > 6) return "moderate";
  return "simple";
}

function tagsFor(file, result) {
  const tags = new Set([file.language, file.fileCategory].filter(Boolean));
  const base = path.basename(file.path).toLowerCase();
  if (/^(readme|contributing|architecture)/.test(base)) tags.add("documentation");
  if (/(^|[._-])(test|spec)([._-]|$)/.test(base)) tags.add("test");
  if (/^(index|main|app|server)\./.test(base)) tags.add("entry-point");
  if (/dockerfile|docker-compose/.test(base)) tags.add("containerization");
  if (nodeTypeForFile(file) === "pipeline") tags.add("ci-cd");
  if (result?.endpoints?.length) tags.add("api-schema");
  if (result?.services?.length) tags.add("service");
  if (result?.resources?.length) tags.add("infrastructure");
  return [...tags].slice(0, 6);
}

function deterministicSummary(file, result, importCount) {
  const symbols = [
    ...(result?.classes || []).map((item) => item.name),
    ...(result?.functions || []).map((item) => item.name),
    ...(result?.services || []).map((item) => item.name),
    ...(result?.endpoints || []).map((item) => item.path),
  ].filter(Boolean);
  const role = {
    code: "源码文件",
    config: "配置文件",
    docs: "项目文档",
    infra: "基础设施定义",
    data: "数据或接口定义",
    script: "执行脚本",
    markup: "界面资源",
  }[file.fileCategory] || "项目文件";
  const details = [];
  if (symbols.length > 0) details.push(`主要结构包括 ${symbols.slice(0, 5).join("、")}`);
  if (importCount > 0) details.push(`依赖 ${importCount} 个项目内部文件`);
  return `${file.path} 是一个 ${file.language || "unknown"} ${role}${
    details.length > 0 ? `，${details.join("，")}` : ""
  }。`;
}

function edgeKey(edge) {
  return `${edge.source}|${edge.target}|${edge.type}`;
}

function addEdge(edges, seen, edge) {
  if (!edge.source || !edge.target || edge.source === edge.target) return;
  const key = edgeKey(edge);
  if (seen.has(key)) return;
  seen.add(key);
  edges.push({
    direction: "forward",
    weight: 0.7,
    ...edge,
  });
}

function significantFunction(fn, exportedNames) {
  return (
    exportedNames.has(fn.name) ||
    Math.max(0, (fn.endLine || 0) - (fn.startLine || 0) + 1) >= 10
  );
}

function significantClass(cls, exportedNames) {
  return (
    exportedNames.has(cls.name) ||
    (cls.methods?.length || 0) >= 2 ||
    Math.max(0, (cls.endLine || 0) - (cls.startLine || 0) + 1) >= 20
  );
}

function buildStaticGraph({ scan, structuresByPath = new Map() }) {
  const files = scan.files || [];
  const fileByPath = new Map(files.map((file) => [file.path, file]));
  const nodeIdByPath = new Map(files.map((file) => [file.path, fileNodeId(file)]));
  const nodes = [];
  const edges = [];
  const seenEdges = new Set();
  const nodeById = new Map();
  const symbolIdsByName = new Map();

  const addNode = (node) => {
    if (nodeById.has(node.id)) return;
    nodeById.set(node.id, node);
    nodes.push(node);
    if (node.type === "function" || node.type === "class") {
      const values = symbolIdsByName.get(node.name) || [];
      values.push(node.id);
      symbolIdsByName.set(node.name, values);
    }
  };

  for (const file of files) {
    const result = structuresByPath.get(file.path);
    const imports = scan.importMap?.[file.path] || [];
    const id = nodeIdByPath.get(file.path);
    addNode({
      id,
      type: nodeTypeForFile(file),
      name: path.basename(file.path),
      filePath: file.path,
      summary: deterministicSummary(file, result, imports.length),
      tags: tagsFor(file, result),
      complexity: complexityFor(result, file),
      languageNotes: file.language ? `主要语言：${file.language}` : undefined,
    });

    const exportedNames = new Set((result?.exports || []).map((item) => item.name));
    for (const fn of (result?.functions || []).filter((item) =>
      significantFunction(item, exportedNames),
    )) {
      const symbolId = `function:${file.path}:${fn.name}`;
      addNode({
        id: symbolId,
        type: "function",
        name: fn.name,
        filePath: file.path,
        lineRange: [fn.startLine, fn.endLine],
        summary: `${fn.name} 是 ${file.path} 中的函数。`,
        tags: ["function", exportedNames.has(fn.name) ? "exported" : "internal"],
        complexity:
          Math.max(0, fn.endLine - fn.startLine + 1) > 80 ? "complex" : "simple",
      });
      addEdge(edges, seenEdges, {
        source: id,
        target: symbolId,
        type: "contains",
        weight: 1,
      });
      if (exportedNames.has(fn.name)) {
        addEdge(edges, seenEdges, {
          source: id,
          target: symbolId,
          type: "exports",
          weight: 0.8,
        });
      }
    }

    for (const cls of (result?.classes || []).filter((item) =>
      significantClass(item, exportedNames),
    )) {
      const symbolId = `class:${file.path}:${cls.name}`;
      addNode({
        id: symbolId,
        type: "class",
        name: cls.name,
        filePath: file.path,
        lineRange: [cls.startLine, cls.endLine],
        summary: `${cls.name} 是 ${file.path} 中的类。`,
        tags: ["class", exportedNames.has(cls.name) ? "exported" : "internal"],
        complexity:
          Math.max(0, cls.endLine - cls.startLine + 1) > 120
            ? "complex"
            : "moderate",
      });
      addEdge(edges, seenEdges, {
        source: id,
        target: symbolId,
        type: "contains",
        weight: 1,
      });
      if (exportedNames.has(cls.name)) {
        addEdge(edges, seenEdges, {
          source: id,
          target: symbolId,
          type: "exports",
          weight: 0.8,
        });
      }
    }

    const structuralGroups = [
      ["services", "service", (item) => item.name],
      [
        "endpoints",
        "endpoint",
        (item) => `${item.method || "ANY"}-${item.path || item.name}`,
      ],
      ["steps", "step", (item) => item.name],
      ["resources", "resource", (item) => item.name],
      ["definitions", "schema", (item) => item.name],
    ];
    for (const [field, type, nameOf] of structuralGroups) {
      for (const item of result?.[field] || []) {
        const name = nameOf(item);
        if (!name) continue;
        const childId = `${type}:${file.path}:${name}`;
        addNode({
          id: childId,
          type,
          name,
          filePath: file.path,
          lineRange:
            item.startLine && item.endLine
              ? [item.startLine, item.endLine]
              : undefined,
          summary: `${name} 定义在 ${file.path} 中。`,
          tags: [type, file.fileCategory],
          complexity: "simple",
        });
        addEdge(edges, seenEdges, {
          source: id,
          target: childId,
          type: "contains",
          weight: 1,
        });
      }
    }
  }

  for (const file of files) {
    const source = nodeIdByPath.get(file.path);
    for (const targetPath of scan.importMap?.[file.path] || []) {
      const target = nodeIdByPath.get(targetPath);
      addEdge(edges, seenEdges, {
        source,
        target,
        type: "imports",
        weight: 0.7,
      });
    }
  }

  for (const file of files) {
    const result = structuresByPath.get(file.path);
    for (const call of result?.callGraph || []) {
      const caller = symbolIdsByName.get(call.caller);
      const callee = symbolIdsByName.get(call.callee);
      const source =
        caller?.find((id) => nodeById.get(id)?.filePath === file.path) ||
        nodeIdByPath.get(file.path);
      if (callee?.length === 1) {
        addEdge(edges, seenEdges, {
          source,
          target: callee[0],
          type: "calls",
          weight: 0.8,
        });
      }
    }
  }

  return { nodes, edges, fileByPath, nodeIdByPath };
}

function applySemanticEnrichment(graph, semanticResults) {
  const enrichmentById = new Map(
    semanticResults.flatMap((value) => value?.nodes || []).map((item) => [item.id, item]),
  );
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const edges = [...graph.edges];
  const seenEdges = new Set(edges.map(edgeKey));

  for (const value of semanticResults) {
    for (const edge of value?.edges || []) {
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
      addEdge(edges, seenEdges, edge);
    }
  }

  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const value = enrichmentById.get(node.id);
      if (!value) return node;
      return {
        ...node,
        summary: value.summary || node.summary,
        tags: [...new Set([...(node.tags || []), ...(value.tags || [])])].slice(0, 8),
        complexity: value.complexity || node.complexity,
        languageNotes: value.languageNotes || node.languageNotes,
      };
    }),
    edges,
  };
}

function batchGraph(graph, batch) {
  const paths = new Set((batch.files || []).map((file) => file.path));
  const nodeIds = new Set(
    graph.nodes.filter((node) => paths.has(node.filePath)).map((node) => node.id),
  );
  return {
    nodes: graph.nodes.filter((node) => nodeIds.has(node.id)),
    edges: graph.edges.filter((edge) => nodeIds.has(edge.source)),
  };
}

module.exports = {
  applySemanticEnrichment,
  batchGraph,
  buildStaticGraph,
  fileNodeId,
  nodeTypeForFile,
};
