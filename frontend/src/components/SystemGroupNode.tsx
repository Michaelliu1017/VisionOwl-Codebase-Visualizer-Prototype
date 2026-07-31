import type { Node, NodeProps } from "@xyflow/react";

export type SystemGroupNodeData = {
  eyebrow: string;
  title: string;
  subtitle: string;
  modules: string[];
};

export type SystemGroupFlowNode = Node<
  SystemGroupNodeData,
  "systemGroup"
>;

export function SystemGroupNode({
  data,
}: NodeProps<SystemGroupFlowNode>) {
  return (
    <section className="system-group" aria-label={`${data.title} 系统边界`}>
      <header className="system-group__header">
        <div>
          <span>{data.eyebrow}</span>
          <strong>{data.title}</strong>
          <small>{data.subtitle}</small>
        </div>
        <div className="system-group__modules" aria-label="内部模块">
          {data.modules.map((module) => (
            <span key={module}>{module}</span>
          ))}
        </div>
      </header>
    </section>
  );
}
