import type { GraphDocument } from "../../types";
import type { Facts } from "../scan";
import type { AnalysisPlan } from "./analysisPackets";

export const FACT_SCHEMA_VERSION = "2.0" as const;
export const SCANNER_VERSION = "2.1.0" as const;

export type FactCertainty = "exact" | "resolved" | "configured" | "unresolved";
export type FactType =
  | "module"
  | "symbol"
  | "import"
  | "call"
  | "route"
  | "http_client"
  | "db"
  | "redis"
  | "mq"
  | "config";

export type FactRelation =
  | "contains"
  | "import"
  | "call"
  | "provide"
  | "require"
  | "read"
  | "write"
  | "publish"
  | "consume"
  | "configure";

export interface FactEvidence {
  file: string;
  startLine: number;
  endLine: number;
  symbol?: string;
  excerptHash: string;
}

export interface FactEndpoint {
  id: string;
  name: string;
  kind: string;
  moduleId?: string;
  path?: string;
  symbol?: string;
}

export interface FactExtractor {
  name: string;
  version: string;
}

export interface NormalizedFact {
  factId: string;
  repositoryId: string;
  commitSha: string;
  language: string;
  type: FactType;
  subject: FactEndpoint;
  relation?: FactRelation;
  object?: FactEndpoint;
  evidence: FactEvidence[];
  extractor: FactExtractor;
  certainty: FactCertainty;
  attributes?: Record<string, string | number | boolean | null>;
}

export interface SymbolDefinition {
  symbolId: string;
  repositoryId: string;
  moduleId: string;
  name: string;
  kind: "function" | "class" | "interface" | "method" | "variable";
  file: string;
  startLine: number;
  endLine: number;
  exported: boolean;
}

export interface SymbolReference {
  fromSymbolId: string | null;
  toSymbolId: string | null;
  name: string;
  file: string;
  line: number;
  certainty: FactCertainty;
}

export interface SymbolIndex {
  schemaVersion: typeof FACT_SCHEMA_VERSION;
  repositoryId: string;
  commitSha: string;
  generatedAt: string;
  definitions: SymbolDefinition[];
  references: SymbolReference[];
}

export interface InterfaceRecord {
  interfaceId: string;
  repositoryId: string;
  moduleId: string;
  direction: "provides" | "requires";
  protocol: "http" | "rpc" | "event" | "package";
  operation: string;
  address: string;
  /** HTTP 服务发现名、规范服务名或人工确认别名。跨仓库 HTTP 建边必须双方一致。 */
  serviceIdentity?: string;
  /** OpenAPI operation、Protobuf RPC 或 Event Schema 的稳定契约标识。 */
  contractId?: string;
  evidence: FactEvidence[];
  certainty: FactCertainty;
}

export interface InterfaceCatalog {
  schemaVersion: typeof FACT_SCHEMA_VERSION;
  repositoryId: string;
  commitSha: string;
  generatedAt: string;
  interfaces: InterfaceRecord[];
}

export interface ResourceRecord {
  resourceId: string;
  repositoryId: string;
  moduleId: string;
  kind: "db" | "redis" | "mq" | "config" | "external";
  name: string;
  operation: FactRelation;
  keyOrTarget: string | null;
  evidence: FactEvidence[];
  certainty: FactCertainty;
}

export interface ResourceCatalog {
  schemaVersion: typeof FACT_SCHEMA_VERSION;
  repositoryId: string;
  commitSha: string;
  generatedAt: string;
  resources: ResourceRecord[];
}

export interface ScannerDiagnostic {
  diagnosticId: string;
  repositoryId: string;
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  file?: string;
  line?: number;
  moduleId?: string;
  factId?: string;
}

export interface DiagnosticsDocument {
  schemaVersion: typeof FACT_SCHEMA_VERSION;
  repositoryId: string;
  commitSha: string;
  generatedAt: string;
  diagnostics: ScannerDiagnostic[];
}

export interface FactIndex {
  schemaVersion: typeof FACT_SCHEMA_VERSION;
  scannerVersion: typeof SCANNER_VERSION;
  repositoryId: string;
  commitSha: string;
  generatedAt: string;
  parserVersions: Record<string, string>;
  facts: NormalizedFact[];
  stats: {
    factCount: number;
    byType: Record<string, number>;
    byCertainty: Record<string, number>;
  };
}

export interface ParserInput {
  root: string;
  repositoryId: string;
  commitSha: string;
  legacyFacts: Facts;
}

export interface ParserOutput {
  parserName: string;
  parserVersion: string;
  facts: NormalizedFact[];
  definitions: SymbolDefinition[];
  references: SymbolReference[];
  interfaces: InterfaceRecord[];
  resources: ResourceRecord[];
  diagnostics: ScannerDiagnostic[];
}

export interface ParserAdapter {
  readonly name: string;
  readonly version: string;
  detect(input: ParserInput): boolean;
  parseFiles(input: ParserInput): ParserOutput;
}

export interface ScanBundleV2 {
  legacyFacts: Facts;
  factIndex: FactIndex;
  symbolIndex: SymbolIndex;
  interfaceCatalog: InterfaceCatalog;
  resourceCatalog: ResourceCatalog;
  diagnostics: DiagnosticsDocument;
  baseGraph: GraphDocument;
  analysisPlan: AnalysisPlan;
}
