import fs from "node:fs";
import path from "node:path";
import { scopedId, stableHash } from "../ids";
import type {
  FactEvidence,
  InterfaceRecord,
  ParserAdapter,
  ParserInput,
  ParserOutput,
} from "../contracts";

const EXTRACTOR = { name: "python-package-contracts", version: "1.0.0" } as const;
const REQUIREMENTS_PATTERN = /^requirements(?:\.[^.]+)?\.txt$/i;

function normalizePackageName(value: string): string {
  return value.trim().toLowerCase().replace(/[._]+/g, "-");
}

function moduleForContracts(input: ParserInput): { id: string; name: string } | null {
  const module = input.legacyFacts.modules
    .slice()
    .sort((left, right) => {
      if (left.modulePath === ".") return -1;
      if (right.modulePath === ".") return 1;
      return left.modulePath.length - right.modulePath.length;
    })[0];
  if (!module) return null;
  return {
    id: scopedId(input.repositoryId, "module", module.modulePath === "." ? "." : module.modulePath),
    name: module.name,
  };
}

function evidence(file: string, line: number, excerpt: string, symbol: string): FactEvidence {
  return {
    file,
    startLine: line,
    endLine: line,
    symbol,
    excerptHash: stableHash(excerpt.trim().slice(0, 500)),
  };
}

function readLines(root: string, file: string): string[] {
  try {
    return fs.readFileSync(path.join(root, file), "utf8").split(/\r?\n/);
  } catch {
    return [];
  }
}

function packageProvider(input: ParserInput): { name: string; evidence: FactEvidence } | null {
  const setupLines = readLines(input.root, "setup.py");
  for (let index = 0; index < setupLines.length; index += 1) {
    const line = setupLines[index] ?? "";
    const match = line.match(/\bname\s*=\s*["']([^"']+)["']/);
    if (match?.[1]) {
      const name = normalizePackageName(match[1]);
      return { name, evidence: evidence("setup.py", index + 1, line, name) };
    }
  }

  for (const file of ["pyproject.toml", "setup.cfg"]) {
    const lines = readLines(input.root, file);
    let inMetadata = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const section = line.trim().match(/^\[([^\]]+)\]$/)?.[1]?.toLowerCase();
      if (section) inMetadata = section === "project" || section === "metadata";
      if (!inMetadata) continue;
      const match = line.match(/^\s*name\s*=\s*["']?([^"'#\s]+)["']?/);
      if (match?.[1]) {
        const name = normalizePackageName(match[1]);
        return { name, evidence: evidence(file, index + 1, line, name) };
      }
    }
  }
  return null;
}

function requirementRecords(input: ParserInput): Array<{ name: string; evidence: FactEvidence }> {
  let files: string[] = [];
  try {
    files = fs.readdirSync(input.root)
      .filter((file) => REQUIREMENTS_PATTERN.test(file))
      .sort();
  } catch {
    return [];
  }

  const records: Array<{ name: string; evidence: FactEvidence }> = [];
  for (const file of files) {
    const lines = readLines(input.root, file);
    for (let index = 0; index < lines.length; index += 1) {
      const raw = lines[index] ?? "";
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith("-")) continue;
      const match = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]+\])?(?:\s*@|\s*(?:===|==|~=|>=|<=|!=|>|<)|\s*$)/);
      if (!match?.[1]) continue;
      const name = normalizePackageName(match[1]);
      records.push({ name, evidence: evidence(file, index + 1, raw, name) });
    }
  }
  return records;
}

function interfaceRecord(
  input: ParserInput,
  moduleId: string,
  direction: InterfaceRecord["direction"],
  packageName: string,
  itemEvidence: FactEvidence,
): InterfaceRecord {
  return {
    interfaceId: `interface:${stableHash(input.repositoryId, moduleId, direction, "package", packageName)}`,
    repositoryId: input.repositoryId,
    moduleId,
    direction,
    protocol: "package",
    operation: "IMPORT",
    address: packageName,
    contractId: `python-package:${packageName}`,
    evidence: [itemEvidence],
    certainty: "exact",
  };
}

export const pythonPackageParser: ParserAdapter = {
  name: EXTRACTOR.name,
  version: EXTRACTOR.version,

  detect(input: ParserInput): boolean {
    if (["setup.py", "pyproject.toml", "setup.cfg"]
      .some((file) => fs.existsSync(path.join(input.root, file)))) return true;
    try {
      return fs.readdirSync(input.root).some((file) => REQUIREMENTS_PATTERN.test(file));
    } catch {
      return false;
    }
  },

  parseFiles(input: ParserInput): ParserOutput {
    const module = moduleForContracts(input);
    const interfaces: InterfaceRecord[] = [];
    if (module) {
      const provider = packageProvider(input);
      if (provider) {
        interfaces.push(interfaceRecord(input, module.id, "provides", provider.name, provider.evidence));
      }
      for (const requirement of requirementRecords(input)) {
        interfaces.push(interfaceRecord(input, module.id, "requires", requirement.name, requirement.evidence));
      }
    }
    return {
      parserName: EXTRACTOR.name,
      parserVersion: EXTRACTOR.version,
      facts: [],
      definitions: [],
      references: [],
      interfaces: [...new Map(interfaces.map((record) => [record.interfaceId, record])).values()],
      resources: [],
      diagnostics: [],
    };
  },
};
