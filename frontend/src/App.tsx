import { CloudWorkspace } from "./cloud/CloudWorkspace";

export type VisionWorkspace = "code" | "runtime";

export function App() {
  return <CloudWorkspace />;
}
