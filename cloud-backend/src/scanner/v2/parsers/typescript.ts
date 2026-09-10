import path from "node:path";
import ts from "typescript";
import { nodeEvidence } from "../evidence";
import { factId, scopedId, stableHash } from "../ids";
import { listSourceFiles, relativePath } from "../files";
import type {
  FactCertainty,
  FactEndpoint,
  FactRelation,
  FactType,
  InterfaceRecord,
  NormalizedFact,
  ParserAdapter,
  ParserInput,
  ParserOutput,
  ResourceRecord,
  ScannerDiagnostic,
  SymbolDefinition,
  SymbolReference,
} from "../contracts";

const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head"]);
const REDIS_READ = new Set(["get", "mget", "hget", "hgetall", "lrange", "smembers", "zrange", "xread", "xreadgroup"]);
const REDIS_WRITE = new Set(["set", "mset", "hset", "del", "lpush", "rpush", "sadd", "zadd", "xadd", "expire"]);
const MQ_PUBLISH = new Set(["publish", "send", "sendbatch"]);
const MQ_CONSUME = new Set(["consume", "subscribe"]);
const SQL_METHODS = new Set(["query", "execute", "raw"]);
const EXTRACTOR = { name: "typescript-compiler-api", version: ts.version } as const;

interface ModuleLookup {
  legacyId: string;
  id: string;
  path: string;
  packageName: string | null;
}

function normalizeModulePath(value: string): string {
  return value === "." ? "" : value.replaceAll("\\", "/").replace(/\/$/, "");
}

function moduleForFile(root: string, fileName: string, modules: ModuleLookup[]): ModuleLookup | null {
  const relative = relativePath(root, fileName);
  return modules
    .filter((module) => module.path === "" || relative === module.path || relative.startsWith(`${module.path}/`))
    .sort((left, right) => right.path.length - left.path.length)[0] ?? null;
}

function declarationKind(node: ts.Node): SymbolDefinition["kind"] | null {
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isMethodDeclaration(node)) return "method";
  if (ts.isVariableDeclaration(node)) return "variable";
  return null;
}

function declarationName(node: ts.Node): string | null {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isVariableDeclaration(node)
  ) {
    const name = node.name;
    if (name && ts.isIdentifier(name)) return name.text;
    if (name && ts.isStringLiteral(name)) return name.text;
  }
  return null;
}

function isExported(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return Boolean(modifiers?.some((modifier: ts.Modifier) =>
    modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword,
  ));
}

function literalText(node: ts.Expression | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function httpTargetText(node: ts.Expression | undefined): string | null {
  const literal = literalText(node);
  if (literal) return literal;
  if (!node || !ts.isTemplateExpression(node)) return null;
  return `${node.head.text}${node.templateSpans
    .map((span) => `\${${span.expression.getText()}}${span.literal.text}`)
    .join("")}`;
}

function plausibleHttpTarget(value: string | null): value is string {
  if (!value) return false;
  const trimmed = value.trim();
  if (!/[A-Za-z0-9]/.test(trimmed)) return false;
  return /^(?:https?:\/\/|\/\/|\/|\$\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z0-9][A-Za-z0-9._-]*(?::\d+)?(?:\/|$))/i.test(trimmed);
}

function propertyCall(node: ts.CallExpression): { receiver: string; method: string } | null {
  if (!ts.isPropertyAccessExpression(node.expression)) return null;
  return {
    receiver: node.expression.expression.getText().toLowerCase(),
    method: node.expression.name.text.toLowerCase(),
  };
}

function nearestNamedDeclaration(node: ts.Node): ts.Node | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (declarationName(current)) return current;
    current = current.parent;
  }
  return null;
}

function sqlOperation(sql: string): { relation: FactRelation; table: string | null } {
  const normalized = sql.trim().replace(/\s+/g, " ");
  const verb = normalized.match(/^(select|insert|update|delete)\b/i)?.[1]?.toLowerCase();
  const table = normalized.match(/\b(?:from|into|update)\s+["`]?([A-Za-z0-9_.-]+)/i)?.[1] ?? null;
  return { relation: verb === "select" ? "read" : "write", table };
}

function makeFact(input: {
  repositoryId: string;
  commitSha: string;
  language?: string;
  type: FactType;
  subject: FactEndpoint;
  relation?: FactRelation;
  object?: FactEndpoint;
  evidence: ReturnType<typeof nodeEvidence>[];
  certainty: FactCertainty;
  attributes?: Record<string, string | number | boolean | null>;
}): NormalizedFact {
  const first = input.evidence[0];
  return {
    factId: factId(
      input.repositoryId,
      input.type,
      input.subject.id,
      input.relation,
      input.object?.id,
      first?.file ?? "",
      first?.startLine ?? 0,
    ),
    repositoryId: input.repositoryId,
    commitSha: input.commitSha,
    language: input.language ?? "typescript",
    type: input.type,
    subject: input.subject,
    relation: input.relation,
    object: input.object,
    evidence: input.evidence,
    extractor: EXTRACTOR,
    certainty: input.certainty,
    attributes: input.attributes,
  };
}

function resourceRecord(fact: NormalizedFact, kind: ResourceRecord["kind"]): ResourceRecord {
  return {
    resourceId: fact.object?.id ?? `resource:${fact.factId}`,
    repositoryId: fact.repositoryId,
    moduleId: fact.subject.moduleId ?? fact.subject.id,
    kind,
    name: fact.object?.name ?? kind,
    operation: fact.relation ?? "require",
    keyOrTarget: typeof fact.attributes?.target === "string" ? fact.attributes.target : null,
    evidence: fact.evidence,
    certainty: fact.certainty,
  };
}

export const typescriptParser: ParserAdapter = {
  name: EXTRACTOR.name,
  version: EXTRACTOR.version,

  detect(input: ParserInput): boolean {
    return listSourceFiles(input.root, EXTENSIONS).length > 0;
  },

  parseFiles(input: ParserInput): ParserOutput {
    const files = listSourceFiles(input.root, EXTENSIONS);
    const modules: ModuleLookup[] = input.legacyFacts.modules.map((module) => ({
      legacyId: module.nodeId,
      id: scopedId(input.repositoryId, "module", module.modulePath === "." ? "." : module.modulePath),
      path: normalizeModulePath(module.modulePath),
      packageName: module.packageName,
    }));
    const packageToModule = new Map(
      modules.filter((module) => module.packageName).map((module) => [module.packageName as string, module]),
    );
    const compilerOptions: ts.CompilerOptions = {
      allowJs: true,
      checkJs: false,
      jsx: ts.JsxEmit.Preserve,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
    };
    const program = ts.createProgram(files, compilerOptions);
    const checker = program.getTypeChecker();
    const facts: NormalizedFact[] = [];
    const definitions: SymbolDefinition[] = [];
    const references: SymbolReference[] = [];
    const interfaces: InterfaceRecord[] = [];
    const resources: ResourceRecord[] = [];
    const diagnostics: ScannerDiagnostic[] = [];
    const definitionByDeclaration = new Map<ts.Declaration, SymbolDefinition>();

    const endpointForDefinition = (definition: SymbolDefinition): FactEndpoint => ({
      id: definition.symbolId,
      name: definition.name,
      kind: definition.kind,
      moduleId: definition.moduleId,
      path: definition.file,
      symbol: definition.name,
    });

    for (const sourceFile of program.getSourceFiles()) {
      if (sourceFile.isDeclarationFile || !sourceFile.fileName.startsWith(path.resolve(input.root))) continue;
      const module = moduleForFile(input.root, sourceFile.fileName, modules);
      if (!module) continue;
      const visitDefinitions = (node: ts.Node): void => {
        const kind = declarationKind(node);
        const name = declarationName(node);
        if (kind && name) {
          const evidence = nodeEvidence(input.root, sourceFile, node, name);
          const symbolId = scopedId(
            input.repositoryId,
            "symbol",
            `${evidence.file}#${name}@${evidence.startLine}`,
          );
          const definition: SymbolDefinition = {
            symbolId,
            repositoryId: input.repositoryId,
            moduleId: module.id,
            name,
            kind,
            file: evidence.file,
            startLine: evidence.startLine,
            endLine: evidence.endLine,
            exported: isExported(node) || ts.isSourceFile(node.parent),
          };
          definitions.push(definition);
          definitionByDeclaration.set(node as ts.Declaration, definition);
          facts.push(makeFact({
            repositoryId: input.repositoryId,
            commitSha: input.commitSha,
            type: "symbol",
            subject: {
              id: module.id,
              name: module.path || ".",
              kind: "module",
              path: module.path || ".",
            },
            relation: "contains",
            object: endpointForDefinition(definition),
            evidence: [evidence],
            certainty: "exact",
            attributes: { symbolKind: kind, exported: definition.exported },
          }));
        }
        ts.forEachChild(node, visitDefinitions);
      };
      visitDefinitions(sourceFile);
    }

    const resolvedDefinition = (expression: ts.Expression): SymbolDefinition | null => {
      let symbol = checker.getSymbolAtLocation(expression);
      if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
        try {
          symbol = checker.getAliasedSymbol(symbol);
        } catch {
          return null;
        }
      }
      for (const declaration of symbol?.declarations ?? []) {
        const found = definitionByDeclaration.get(declaration);
        if (found) return found;
      }
      return null;
    };

    for (const sourceFile of program.getSourceFiles()) {
      if (sourceFile.isDeclarationFile || !sourceFile.fileName.startsWith(path.resolve(input.root))) continue;
      const module = moduleForFile(input.root, sourceFile.fileName, modules);
      if (!module) continue;
      const moduleEndpoint: FactEndpoint = {
        id: module.id,
        name: module.path || ".",
        kind: "module",
        path: module.path || ".",
      };

      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          const specifier = node.moduleSpecifier.text;
          const packageRoot = specifier.startsWith("@")
            ? specifier.split("/").slice(0, 2).join("/")
            : specifier.split("/")[0] ?? specifier;
          const target = packageToModule.get(packageRoot);
          const evidence = nodeEvidence(input.root, sourceFile, node, specifier);
          if (target && target.id !== module.id) {
            facts.push(makeFact({
              repositoryId: input.repositoryId,
              commitSha: input.commitSha,
              type: "import",
              subject: moduleEndpoint,
              relation: "import",
              object: { id: target.id, name: target.path, kind: "module", path: target.path },
              evidence: [evidence],
              certainty: "resolved",
              attributes: { specifier },
            }));
          }
        }

        if (ts.isCallExpression(node)) {
          const call = propertyCall(node);
          const routePath = call && HTTP_METHODS.has(call.method) ? literalText(node.arguments[0]) : null;
          if (call && routePath && /(?:app|router|server|fastify)/i.test(call.receiver)) {
            const evidence = nodeEvidence(input.root, sourceFile, node, `${call.method.toUpperCase()} ${routePath}`);
            const routeId = scopedId(input.repositoryId, "route", `${call.method.toUpperCase()}:${routePath}`);
            const routeFact = makeFact({
              repositoryId: input.repositoryId,
              commitSha: input.commitSha,
              type: "route",
              subject: moduleEndpoint,
              relation: "provide",
              object: { id: routeId, name: `${call.method.toUpperCase()} ${routePath}`, kind: "route", moduleId: module.id, path: evidence.file },
              evidence: [evidence],
              certainty: "exact",
              attributes: { method: call.method.toUpperCase(), path: routePath },
            });
            facts.push(routeFact);
            interfaces.push({
              interfaceId: routeId,
              repositoryId: input.repositoryId,
              moduleId: module.id,
              direction: "provides",
              protocol: "http",
              operation: call.method.toUpperCase(),
              address: routePath,
              evidence: routeFact.evidence,
              certainty: routeFact.certainty,
            });
          }

          const calleeText = node.expression.getText(sourceFile);
          const httpTarget = ts.isIdentifier(node.expression) && node.expression.text === "fetch"
            ? httpTargetText(node.arguments[0])
            : call && /(?:axios|https?|request|got|api[-_]?client)/i.test(call.receiver) &&
                (HTTP_METHODS.has(call.method) || call.method === "request")
              ? httpTargetText(node.arguments[0])
              : null;
          if (plausibleHttpTarget(httpTarget)) {
            const evidence = nodeEvidence(input.root, sourceFile, node, calleeText);
            const targetId = scopedId(input.repositoryId, "external", httpTarget);
            const httpFact = makeFact({
              repositoryId: input.repositoryId,
              commitSha: input.commitSha,
              type: "http_client",
              subject: moduleEndpoint,
              relation: "require",
              object: { id: targetId, name: httpTarget, kind: "external" },
              evidence: [evidence],
              certainty: "configured",
              attributes: { target: httpTarget, client: calleeText },
            });
            facts.push(httpFact);
            interfaces.push({
              interfaceId: targetId,
              repositoryId: input.repositoryId,
              moduleId: module.id,
              direction: "requires",
              protocol: "http",
              operation: call?.method.toUpperCase() ?? "REQUEST",
              address: httpTarget,
              evidence: httpFact.evidence,
              certainty: httpFact.certainty,
            });
            resources.push(resourceRecord(httpFact, "external"));
          }

          if (call && SQL_METHODS.has(call.method)) {
            const sql = literalText(node.arguments[0]);
            if (sql) {
              const operation = sqlOperation(sql);
              const target = operation.table ?? "sql:dynamic-table";
              const dbFact = makeFact({
                repositoryId: input.repositoryId,
                commitSha: input.commitSha,
                type: "db",
                subject: moduleEndpoint,
                relation: operation.relation,
                object: { id: scopedId(input.repositoryId, "db", target), name: target, kind: "db" },
                evidence: [nodeEvidence(input.root, sourceFile, node, call.method)],
                certainty: operation.table ? "exact" : "unresolved",
                attributes: { target },
              });
              facts.push(dbFact);
              resources.push(resourceRecord(dbFact, "db"));
            }
          }

          if (call && (REDIS_READ.has(call.method) || REDIS_WRITE.has(call.method)) && /(?:redis|cache)/i.test(call.receiver)) {
            const key = literalText(node.arguments[0]);
            const redisFact = makeFact({
              repositoryId: input.repositoryId,
              commitSha: input.commitSha,
              type: "redis",
              subject: moduleEndpoint,
              relation: REDIS_READ.has(call.method) ? "read" : "write",
              object: { id: scopedId(input.repositoryId, "redis", key ?? "dynamic-key"), name: key ?? "dynamic key", kind: "redis" },
              evidence: [nodeEvidence(input.root, sourceFile, node, call.method)],
              certainty: key ? "exact" : "unresolved",
              attributes: { command: call.method.toUpperCase(), target: key },
            });
            facts.push(redisFact);
            resources.push(resourceRecord(redisFact, "redis"));
          }

          if (call && (MQ_PUBLISH.has(call.method) || MQ_CONSUME.has(call.method)) && /(?:bus|queue|kafka|mq|producer|consumer)/i.test(call.receiver)) {
            const topic = literalText(node.arguments[0]);
            const relation: FactRelation = MQ_CONSUME.has(call.method) ? "consume" : "publish";
            const mqFact = makeFact({
              repositoryId: input.repositoryId,
              commitSha: input.commitSha,
              type: "mq",
              subject: moduleEndpoint,
              relation,
              object: { id: scopedId(input.repositoryId, "mq", topic ?? "dynamic-topic"), name: topic ?? "dynamic topic", kind: "mq" },
              evidence: [nodeEvidence(input.root, sourceFile, node, call.method)],
              certainty: topic ? "exact" : "unresolved",
              attributes: { operation: call.method, target: topic },
            });
            facts.push(mqFact);
            resources.push(resourceRecord(mqFact, "mq"));
            if (topic) {
              interfaces.push({
                interfaceId: mqFact.object!.id,
                repositoryId: input.repositoryId,
                moduleId: module.id,
                direction: relation === "publish" ? "provides" : "requires",
                protocol: "event",
                operation: relation,
                address: topic,
                evidence: mqFact.evidence,
                certainty: mqFact.certainty,
              });
            }
          }

          const target = resolvedDefinition(node.expression);
          if (target && target.moduleId !== module.id) {
            const enclosing = nearestNamedDeclaration(node);
            const sourceDefinition = enclosing
              ? definitionByDeclaration.get(enclosing as ts.Declaration)
              : undefined;
            const subject = sourceDefinition ? endpointForDefinition(sourceDefinition) : moduleEndpoint;
            const callFact = makeFact({
              repositoryId: input.repositoryId,
              commitSha: input.commitSha,
              type: "call",
              subject,
              relation: "call",
              object: endpointForDefinition(target),
              evidence: [nodeEvidence(input.root, sourceFile, node, calleeText)],
              certainty: "resolved",
            });
            facts.push(callFact);
            references.push({
              fromSymbolId: sourceDefinition?.symbolId ?? null,
              toSymbolId: target.symbolId,
              name: target.name,
              file: callFact.evidence[0]!.file,
              line: callFact.evidence[0]!.startLine,
              certainty: "resolved",
            });
          }
        }

        if (
          ts.isPropertyAccessExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "process" &&
          node.expression.name.text === "env"
        ) {
          const variable = node.name.text;
          const configFact = makeFact({
            repositoryId: input.repositoryId,
            commitSha: input.commitSha,
            type: "config",
            subject: moduleEndpoint,
            relation: "configure",
            object: { id: scopedId(input.repositoryId, "config", variable), name: variable, kind: "config" },
            evidence: [nodeEvidence(input.root, sourceFile, node, variable)],
            certainty: "exact",
            attributes: { target: variable },
          });
          facts.push(configFact);
          resources.push(resourceRecord(configFact, "config"));
        }

        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }

    for (const diagnostic of ts.getPreEmitDiagnostics(program).slice(0, 100)) {
      if (!diagnostic.file || diagnostic.start === undefined) continue;
      if (!diagnostic.file.fileName.startsWith(path.resolve(input.root))) continue;
      const location = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      diagnostics.push({
        diagnosticId: `diag:${stableHash(input.repositoryId, diagnostic.code, diagnostic.file.fileName, diagnostic.start)}`,
        repositoryId: input.repositoryId,
        severity: "warning",
        code: `TS${diagnostic.code}`,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " ").slice(0, 300),
        file: relativePath(input.root, diagnostic.file.fileName),
        line: location.line + 1,
        moduleId: moduleForFile(input.root, diagnostic.file.fileName, modules)?.id,
      });
    }

    const uniqueFacts = new Map(facts.map((fact) => [fact.factId, fact]));
    const uniqueResources = new Map(resources.map((resource) => [
      `${resource.moduleId}:${resource.kind}:${resource.name}:${resource.operation}`,
      resource,
    ]));
    const uniqueInterfaces = new Map(interfaces.map((record) => [
      `${record.moduleId}:${record.direction}:${record.protocol}:${record.operation}:${record.address}`,
      record,
    ]));

    return {
      parserName: EXTRACTOR.name,
      parserVersion: EXTRACTOR.version,
      facts: [...uniqueFacts.values()].sort((left, right) => left.factId.localeCompare(right.factId)),
      definitions: definitions.sort((left, right) => left.symbolId.localeCompare(right.symbolId)),
      references: references.sort((left, right) => `${left.file}:${left.line}`.localeCompare(`${right.file}:${right.line}`)),
      interfaces: [...uniqueInterfaces.values()].sort((left, right) => left.interfaceId.localeCompare(right.interfaceId)),
      resources: [...uniqueResources.values()].sort((left, right) => left.resourceId.localeCompare(right.resourceId)),
      diagnostics: diagnostics.sort((left, right) => left.diagnosticId.localeCompare(right.diagnosticId)),
    };
  },
};
