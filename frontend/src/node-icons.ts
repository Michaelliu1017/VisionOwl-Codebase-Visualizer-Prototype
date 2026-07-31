import {
  Activity,
  AlertTriangle,
  Boxes,
  CloudCog,
  Cpu,
  Database,
  FileJson2,
  Globe2,
  Inbox,
  ListTodo,
  MapPin,
  MonitorCog,
  RadioTower,
  ServerCog,
  Users,
  type LucideIcon,
} from "lucide-react";

type IconCandidate = {
  category?: string;
  entityType?: string;
  id?: string;
};

export function iconForNode(node: IconCandidate): LucideIcon {
  const value = `${node.category || ""} ${node.entityType || ""} ${
    node.id || ""
  }`.toLowerCase();

  if (value.includes("worker")) return Cpu;
  if (value.includes("agent-rest") || value.includes("agent_rest")) {
    return ServerCog;
  }
  if (value.includes("probe")) return RadioTower;
  if (value.includes("evidence")) return Activity;
  if (value.includes("queue")) return Inbox;
  if (value.includes("task")) return ListTodo;
  if (value.includes("impact")) return AlertTriangle;
  if (value.includes("peer")) return Users;
  if (value.includes("redis") || value.includes("mysql")) return Database;
  if (value.includes("report") || value.includes("ndjson")) return FileJson2;
  if (value.includes("target")) return Globe2;
  if (value.includes("region")) return MapPin;
  if (value.includes("umodel") || value.includes("online")) return CloudCog;
  if (value.includes("control") || value.includes("console")) return MonitorCog;
  return Boxes;
}
