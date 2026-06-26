import { ReactFlow } from "@xyflow/react";
import type { Node, Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

const EMPTY_NODES: Node[] = [];
const EMPTY_EDGES: Edge[] = [];

export function App() {
  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      <ReactFlow nodes={EMPTY_NODES} edges={EMPTY_EDGES} fitView />
    </div>
  );
}

export default App;
