import fs from "node:fs";
import path from "node:path";
import { listSourceFiles, relativePath } from "../files";
import { factId, scopedId, stableHash } from "../ids";
import type {
  FactRelation,
  FactType,
  NormalizedFact,
  ParserAdapter,
  ParserInput,
  ParserOutput,
  ResourceRecord,
} from "../contracts";

const EXTENSIONS = new Set([".go", ".java", ".kt", ".kts", ".py", ".rb", ".rs", ".cs", ".php"]);
const EXTRACTOR = { name: "generic-resource-signals", version: "1.0.0" } as const;

interface Signal {
  type: Extract<FactType, "db" | "redis" | "mq">;
  relation: FactRelation;
  kind: "db" | "redis" | "mq";
  name: string;
  pattern: RegExp;
}

const SIGNALS: Signal[] = [
  {
    type: "redis",
    relation: "read",
    kind: "redis",
    name: "Redis",
    pattern: /\b(?:CommonRedisUtils|RedisTemplate|StringRedisTemplate|Jedis|Redisson|Lettuce|go-redis|redis\.Client)\b/i,
  },
  {
    type: "db",
    relation: "write",
    kind: "db",
    name: "Database",
    pattern: /\b(?:JdbcTemplate|SqlSession|MyBatis|EntityManager|javax\.sql|java\.sql|DataSource|database\/sql|gorm\.io|MongoTemplate)\b/i,
  },
  {
    type: "mq",
    relation: "publish",
    kind: "mq",
    name: "Message Queue",
    pattern: /\b(?:RocketMQ|KafkaProducer|KafkaConsumer|RabbitTemplate|RabbitMQ|amqplib|NatsConnection|MessageQueueProducer|MessageQueueConsumer)\b/i,
  },
];

interface ModuleLookup {
  id: string;
  path: string;
}

function moduleForFile(root: string, file: string, modules: ModuleLookup[]): ModuleLookup | null {
  const relative = relativePath(root, file);
  return modules
    .filter((module) => module.path === "" || relative === module.path || relative.startsWith(`${module.path}/`))
    .sort((left, right) => right.path.length - left.path.length)[0] ?? null;
}

function resourceRecord(fact: NormalizedFact, kind: ResourceRecord["kind"]): ResourceRecord {
  return {
    resourceId: fact.object!.id,
    repositoryId: fact.repositoryId,
    moduleId: fact.subject.id,
    kind,
    name: fact.object!.name,
    operation: fact.relation ?? "require",
    keyOrTarget: fact.object!.name,
    evidence: fact.evidence,
    certainty: fact.certainty,
  };
}

function detectSignal(content: string, signal: Signal): { line: number; excerpt: string } | null {
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    signal.pattern.lastIndex = 0;
    if (signal.pattern.test(line)) return { line: index + 1, excerpt: line.trim().slice(0, 500) };
  }
  return null;
}

export const genericResourceParser: ParserAdapter = {
  name: EXTRACTOR.name,
  version: EXTRACTOR.version,

  detect(input: ParserInput): boolean {
    return listSourceFiles(input.root, EXTENSIONS).length > 0;
  },

  parseFiles(input: ParserInput): ParserOutput {
    const modules: ModuleLookup[] = input.legacyFacts.modules.map((module) => ({
      id: scopedId(input.repositoryId, "module", module.modulePath === "." ? "." : module.modulePath),
      path: module.modulePath === "." ? "" : module.modulePath.replaceAll("\\", "/").replace(/\/$/, ""),
    }));
    const found = new Map<string, NormalizedFact>();

    for (const absoluteFile of listSourceFiles(input.root, EXTENSIONS)) {
      const module = moduleForFile(input.root, absoluteFile, modules);
      if (!module) continue;
      const relativeFile = relativePath(input.root, absoluteFile);
      if (/(^|\/)(?:test|tests|fixtures?|examples?)(\/|$)|\.(?:spec|test)\.[^.]+$/i.test(relativeFile)) continue;
      let content: string;
      try {
        content = fs.readFileSync(absoluteFile, "utf8");
      } catch {
        continue;
      }
      for (const signal of SIGNALS) {
        const key = `${module.id}:${signal.type}`;
        if (found.has(key)) continue;
        const match = detectSignal(content, signal);
        if (!match) continue;
        const targetId = scopedId(input.repositoryId, signal.kind, signal.name.toLowerCase().replaceAll(" ", "-"));
        const evidence = {
          file: relativeFile,
          startLine: match.line,
          endLine: match.line,
          symbol: signal.name,
          excerptHash: stableHash(match.excerpt),
        };
        found.set(key, {
          factId: factId(input.repositoryId, signal.type, module.id, signal.relation, targetId, relativeFile, match.line),
          repositoryId: input.repositoryId,
          commitSha: input.commitSha,
          language: path.extname(absoluteFile).slice(1) || "generic",
          type: signal.type,
          subject: { id: module.id, name: module.path || ".", kind: "module", path: module.path || "." },
          relation: signal.relation,
          object: { id: targetId, name: signal.name, kind: signal.kind },
          evidence: [evidence],
          extractor: EXTRACTOR,
          certainty: "configured",
          attributes: { target: signal.name, signal: EXTRACTOR.name },
        });
      }
    }

    const facts = [...found.values()].sort((left, right) => left.factId.localeCompare(right.factId));
    return {
      parserName: EXTRACTOR.name,
      parserVersion: EXTRACTOR.version,
      facts,
      definitions: [],
      references: [],
      interfaces: [],
      resources: facts.map((fact) => resourceRecord(fact, fact.type as ResourceRecord["kind"])),
      diagnostics: [],
    };
  },
};
