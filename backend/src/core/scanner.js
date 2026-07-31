"use strict";

const fs = require("fs");
const path = require("path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");

const CODE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".go",
  ".h",
  ".hpp",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".m",
  ".mm",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".scala",
  ".sh",
  ".swift",
  ".ts",
  ".tsx",
  ".vue",
]);

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".idea",
  ".next",
  ".turbo",
  ".venv",
  ".vscode",
  "build",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "out",
  "target",
  "vendor",
]);

const LANGUAGE_BY_EXTENSION = {
  ".c": "C",
  ".cc": "C++",
  ".cpp": "C++",
  ".cs": "C#",
  ".go": "Go",
  ".h": "C/C++",
  ".hpp": "C++",
  ".java": "Java",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".kt": "Kotlin",
  ".kts": "Kotlin",
  ".m": "Objective-C",
  ".mm": "Objective-C++",
  ".php": "PHP",
  ".py": "Python",
  ".rb": "Ruby",
  ".rs": "Rust",
  ".scala": "Scala",
  ".sh": "Shell",
  ".swift": "Swift",
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".vue": "Vue",
};

const MODULE_ROOTS = new Set([
  "apps",
  "cmd",
  "components",
  "internal",
  "lib",
  "modules",
  "packages",
  "pkg",
  "services",
  "src",
]);

function stableId(prefix, value) {
  return `${prefix}:${createHash("sha1").update(value).digest("hex").slice(0, 16)}`;
}

function gitValue(repoPath, args) {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    timeout: 3000,
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function walkCodeFiles(repoPath, limit = 5000, onProgress = () => {}) {
  const result = [];
  const stack = [repoPath];
  while (stack.length > 0 && result.length < limit) {
    const directory = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (_error) {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (result.length >= limit) break;
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) stack.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      if (!CODE_EXTENSIONS.has(extension)) continue;
      try {
        if (fs.statSync(absolute).size <= 512 * 1024) {
          result.push(absolute);
          if (result.length % 250 === 0) onProgress(result.length);
        }
      } catch (_error) {
        // Ignore files that disappear during a scan.
      }
    }
  }
  return result.sort();
}

function modulePath(relativeFile) {
  const parts = relativeFile.split("/");
  if (parts.length === 1) return "root";
  const anchor = parts.findIndex((part) => MODULE_ROOTS.has(part));
  if (anchor >= 0) {
    const hasNestedModule = anchor + 2 < parts.length;
    return parts
      .slice(0, hasNestedModule ? anchor + 2 : anchor + 1)
      .join("/");
  }
  return parts[0];
}

function dominantLanguage(files) {
  const counts = new Map();
  for (const file of files) {
    const language = LANGUAGE_BY_EXTENSION[path.extname(file).toLowerCase()] || "Code";
    counts.set(language, (counts.get(language) || 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || "Code";
}

function codeCandidates(base) {
  return [
    base,
    ...[...CODE_EXTENSIONS].map((extension) => `${base}${extension}`),
    ...[...CODE_EXTENSIONS].map((extension) => path.join(base, `index${extension}`)),
  ];
}

function firstString(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  for (const key of ["import", "default", "require", "types"]) {
    const resolved = firstString(value[key]);
    if (resolved) return resolved;
  }
  return "";
}

function workspacePackageIndex(repoPath, files, fileSet) {
  const packageFiles = new Set();
  const visitedDirectories = new Set();
  for (const file of files) {
    let directory = path.dirname(file);
    while (
      directory === repoPath ||
      directory.startsWith(`${repoPath}${path.sep}`)
    ) {
      if (visitedDirectories.has(directory)) break;
      visitedDirectories.add(directory);
      const packageFile = path.join(directory, "package.json");
      if (fs.existsSync(packageFile)) packageFiles.add(packageFile);
      if (directory === repoPath) break;
      directory = path.dirname(directory);
    }
  }

  const index = new Map();
  for (const packageFile of packageFiles) {
    try {
      const manifest = JSON.parse(fs.readFileSync(packageFile, "utf8"));
      if (!manifest.name) continue;
      const root = path.dirname(packageFile);
      const dotExport =
        typeof manifest.exports === "object" ? manifest.exports["."] : manifest.exports;
      const entryValues = [
        firstString(dotExport),
        manifest.module,
        manifest.main,
        manifest.types,
        "src/index",
        "index",
      ].filter(Boolean);
      const entry =
        entryValues
          .flatMap((value) => codeCandidates(path.resolve(root, value)))
          .find((candidate) => fileSet.has(candidate)) ||
        files.find(
          (file) => file.startsWith(`${root}${path.sep}`) || file === root,
        );
      if (entry) index.set(manifest.name, { root, entry });
    } catch (_error) {
      // A malformed package manifest should not block the rest of the scan.
    }
  }
  return index;
}

function resolveImport(sourceFile, specifier, fileSet, packageIndex) {
  if (specifier.startsWith(".")) {
    const base = path.resolve(path.dirname(sourceFile), specifier);
    return codeCandidates(base).find((candidate) => fileSet.has(candidate)) || null;
  }

  const packageName = [...packageIndex.keys()]
    .sort((left, right) => right.length - left.length)
    .find(
      (name) => specifier === name || specifier.startsWith(`${name}/`),
    );
  if (!packageName) return null;
  const localPackage = packageIndex.get(packageName);
  if (specifier === packageName) return localPackage.entry;
  const subpath = specifier.slice(packageName.length + 1);
  const base = path.resolve(localPackage.root, subpath);
  const candidates = [
    ...codeCandidates(base),
    ...codeCandidates(path.join(localPackage.root, "src", subpath)),
  ];
  return candidates.find((candidate) => fileSet.has(candidate)) || null;
}

function importsInFile(filePath) {
  let text = "";
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (_error) {
    return [];
  }

  const patterns = [
    /\b(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["'`]([^"'`]+)["'`]/g,
    /\brequire\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    /\bimport\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    /^\s*from\s+([.\w]+)\s+import\s+/gm,
  ];
  const imports = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const index = match.index || 0;
      imports.push({
        specifier: match[1],
        line: text.slice(0, index).split("\n").length,
        excerpt: match[0].trim().slice(0, 180),
      });
    }
  }
  return imports;
}

function displayName(value) {
  if (value === "root") return "Root";
  return value
    .split("/")
    .at(-1)
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function validateGraph(graph) {
  const ids = new Set(graph.entities.map((entity) => entity.id));
  graph.relations = graph.relations.filter(
    (relation) =>
      relation.source !== relation.target &&
      ids.has(relation.source) &&
      ids.has(relation.target),
  );
  return graph;
}

function scanRepository(repoPath, project, onProgress = () => {}) {
  onProgress("inventory", 10, "正在遍历目录并筛选源码文件");
  const files = walkCodeFiles(repoPath, 5000, (count) => {
    const progress = Math.min(22, 10 + Math.floor(count / 250));
    onProgress("inventory", progress, `已发现 ${count} 个源码文件，继续扫描`);
  });
  onProgress("inventory", 24, `源码盘点完成，共发现 ${files.length} 个文件`);
  const fileSet = new Set(files);
  const packageIndex = workspacePackageIndex(repoPath, files, fileSet);
  onProgress(
    "facts",
    30,
    `已识别 ${packageIndex.size} 个本地包，正在划分代码模块`,
  );
  const relativeByAbsolute = new Map(
    files.map((file) => [file, path.relative(repoPath, file).split(path.sep).join("/")]),
  );
  const moduleByFile = new Map(
    files.map((file) => [file, modulePath(relativeByAbsolute.get(file))]),
  );
  const filesByModule = new Map();

  for (const file of files) {
    const key = moduleByFile.get(file);
    const values = filesByModule.get(key) || [];
    values.push(file);
    filesByModule.set(key, values);
  }
  onProgress("facts", 38, `已将源码划分为 ${filesByModule.size} 个模块`);

  const entities = [];

  const entityIdByModule = new Map();
  for (const [key, moduleFiles] of [...filesByModule.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const id = stableId("code", `${project.id}:${key}`);
    entityIdByModule.set(key, id);
    const relativeFiles = moduleFiles.map((file) => relativeByAbsolute.get(file));
    const language = dominantLanguage(moduleFiles);
    entities.push({
      id,
      projectId: project.id,
      category: "code",
      kind: "module",
      name: displayName(key),
      summary: `${language} module containing ${moduleFiles.length} source file${moduleFiles.length === 1 ? "" : "s"}.`,
      status: "healthy",
      path: key,
      language,
      layer: key.split("/")[0],
      tags: [language.toLowerCase(), "generated"],
      metadata: {
        fileCount: moduleFiles.length,
        files: relativeFiles.slice(0, 80),
      },
      evidence: relativeFiles.slice(0, 4).map((file) => ({ file, line: 1 })),
    });
  }

  const relations = [];

  const relationByKey = new Map();
  for (const [fileIndex, sourceFile] of files.entries()) {
    const sourceModule = moduleByFile.get(sourceFile);
    const sourceId = entityIdByModule.get(sourceModule);
    if (!sourceId) continue;
    for (const imported of importsInFile(sourceFile)) {
      const targetFile = resolveImport(
        sourceFile,
        imported.specifier,
        fileSet,
        packageIndex,
      );
      if (!targetFile) continue;
      const targetModule = moduleByFile.get(targetFile);
      const targetId = entityIdByModule.get(targetModule);
      if (!targetId || targetId === sourceId) continue;
      const key = `${sourceId}|${targetId}|depends_on`;
      const evidence = {
        file: relativeByAbsolute.get(sourceFile),
        line: imported.line,
        excerpt: imported.excerpt,
      };
      const existing = relationByKey.get(key);
      if (existing) {
        if (existing.evidence.length < 8) existing.evidence.push(evidence);
        existing.metadata.references += 1;
      } else {
        relationByKey.set(key, {
          id: stableId("relation", key),
          projectId: project.id,
          source: sourceId,
          target: targetId,
          type: "depends_on",
          label: "depends on",
          status: "healthy",
          directed: true,
          generated: true,
          metadata: { references: 1 },
          evidence: [evidence],
        });
      }
    }
    if ((fileIndex + 1) % 250 === 0 || fileIndex === files.length - 1) {
      const ratio = files.length === 0 ? 1 : (fileIndex + 1) / files.length;
      onProgress(
        "facts",
        42 + Math.floor(ratio * 16),
        `正在解析模块依赖 ${fileIndex + 1} / ${files.length}`,
      );
    }
  }
  relations.push(...relationByKey.values());
  onProgress(
    "facts",
    60,
    `事实提取完成，共确认 ${relations.length} 条模块关系`,
  );

  return validateGraph({
    source: "scanner",
    branch: gitValue(repoPath, ["branch", "--show-current"]) || undefined,
    commit: gitValue(repoPath, ["rev-parse", "--short=12", "HEAD"]) || undefined,
    entities,
    relations,
    inventory: {
      files: files.length,
      modules: entityIdByModule.size,
      truncated: files.length >= 5000,
    },
  });
}

module.exports = {
  scanRepository,
  validateGraph,
};
