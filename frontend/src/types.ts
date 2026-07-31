import type { LucideIcon } from "lucide-react";

export type HealthState = "healthy" | "warning" | "error" | "offline";
export type MonitorMode = "local" | "online";
export type DiagnosisStatus =
  | "healthy"
  | "suspected"
  | "abnormal"
  | "insufficient_evidence";
export type ConfidenceLevel = "high" | "medium" | "low";
export type EventSeverity = "info" | "warning" | "error";
export type FlowDirection = "forward" | "reverse";
export type EdgeFlow = "task" | "report" | "control";

export type EdgePoint = {
  x: number;
  y: number;
};

export type DetailRow = {
  label: string;
  value: string;
  tone?: HealthState;
  mono?: boolean;
};

export type StatusCounts = {
  healthy: number;
  suspected: number;
  abnormal: number;
  insufficient_evidence: number;
};

export type NodeDiagnosis = {
  status: DiagnosisStatus;
  statusLabel: string;
  confidence: ConfidenceLevel;
  boundary: string;
};

export type IdcProbeDescriptor = {
  id: string;
  title: string;
  subtitle: string;
  status: HealthState;
  details: DetailRow[];
  incidentId?: string;
};

export type MonitorNode = {
  id: string;
  title: string;
  subtitle: string;
  category: string;
  status: HealthState;
  icon: LucideIcon;
  position: { x: number; y: number };
  metric?: string;
  metricLabel?: string;
  details: DetailRow[];
  entityType?: string;
  region?: string;
  memberCount?: number;
  statusCounts?: StatusCounts;
  incidentId?: string;
  diagnosis?: NodeDiagnosis;
  idcProbes?: IdcProbeDescriptor[];
  ordinaryProbeStatus?: HealthState;
  presentation?:
    | "default"
    | "compact"
    | "root"
    | "junction"
    | "expanded-group";
  groupSize?: { width: number; height: number };
  aggregateId?: string;
};

export type MonitorEdge = {
  id: string;
  source: string;
  target: string;
  label: string;
  sourceHandle?: string;
  targetHandle?: string;
  flow?: EdgeFlow;
  severity?: EventSeverity;
  relationKind?: string;
  routePoints?: EdgePoint[];
  labelPosition?: EdgePoint;
};

export type MonitorEvent = {
  id: string;
  step: number;
  cursor?: number;
  observedAt?: string;
  confidence?: "observed" | "derived" | "historical";
  mocked?: boolean;
  kind:
    | "task-created"
    | "task-saved"
    | "task-published"
    | "probe-register"
    | "agent-cached"
    | "worker-scan"
    | "worker-dispatch"
    | "probe-fetch"
    | "queue-pop"
    | "task-delivered"
    | "probe-request"
    | "probe-response"
    | "report-upload"
    | "report-local"
    | "report-sls"
    | "health-updated"
    | "diagnosis-updated";
  title: string;
  detail: string;
  edgeId: string;
  direction: FlowDirection;
  sourceId: string;
  targetId: string;
  severity: EventSeverity;
  timestamp: string;
  taskId: string;
  clientId?: string;
  transactionId?: string;
  incidentId?: string;
};

export type MonitorMetrics = {
  workers: number;
  agentRests: number;
  probes: number;
  queued: number;
  scheduled: number;
  reports: number;
  suspected?: number;
  abnormal?: number;
  insufficientEvidence?: number;
  interactions?: number;
};

export type IncidentTimelineItem = {
  at: string;
  title: string;
  detail: string;
  severity: EventSeverity;
};

export type EvidencePlane = {
  observed: boolean;
  [key: string]: boolean | number | string | null;
};

export type MonitorIncident = {
  id: string;
  title: string;
  status: DiagnosisStatus;
  statusLabel: string;
  confidence: ConfidenceLevel;
  boundary: string;
  affectedGroupId: string;
  rootEntityId: string;
  startedAt: string;
  updatedAt: string;
  summary: string;
  skill: {
    id: string;
    version: string;
    source: string;
  };
  affected: {
    tasks: number;
    targets: number;
    probes: number;
  };
  reasons: string[];
  dataGaps: string[];
  evidencePlanes: Record<string, EvidencePlane>;
  timeline: IncidentTimelineItem[];
  graph: {
    nodes: MonitorNode[];
    edges: MonitorEdge[];
  };
};

export type HealthSummary = {
  generatedAt: string;
  mocked: boolean;
  skill: {
    id: string;
    version: string;
  };
  summary: StatusCounts;
};
