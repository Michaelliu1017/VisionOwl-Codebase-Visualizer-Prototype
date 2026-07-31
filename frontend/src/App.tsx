import { CodeWorkspace } from "./code/CodeWorkspace";

export type VisionWorkspace = "code" | "runtime";

export function App() {
  return <CodeWorkspace />;
}
