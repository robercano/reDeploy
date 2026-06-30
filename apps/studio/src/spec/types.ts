/**
 * Studio-local node and edge data types for the React Flow authoring canvas.
 *
 * These types describe the in-memory graph that the canvas stores, which is
 * then serialized to DeploymentSpec + ConfigSpec via graph-to-spec.ts.
 *
 * ## Node types
 *
 * - ContractNodeData: represents a single deployable contract. It holds the
 *   deployment id, the Solidity artifact name, and a list of constructor arg
 *   slots. Each arg slot is either a literal value or a "ref" placeholder that
 *   gets filled in by an incoming edge.
 *
 * ## Edge types
 *
 * Two logical kinds of edges:
 *
 * 1. ConstructorRefEdge (edgeKind = "constructorRef")
 *    source handle: "<contractId>-output"
 *    target handle: "<contractId>-arg-<index>"
 *    Maps to: ContractArg at position <index> in target ContractEntry.args →
 *             RefArg { kind: "ref", contract: <source node id> }
 *
 * 2. WireEdge (edgeKind = "wire")
 *    source handle: "<contractId>-output"
 *    target handle: "<contractId>-input"
 *    data must carry: wireStepId (unique step id), wireFunction (setter name)
 *    Maps to: WireStep { kind: "wire", id, source: <source node id>,
 *             into: <target node id>, function: <wireFunction> }
 */

/** A single constructor argument slot on a contract node. */
export interface ArgSlot {
  /** Position index in the constructor args array. */
  index: number;
  /**
   * "literal" — a plain JSON value entered by the user.
   * "ref"     — filled by an incoming constructorRef edge; value is ignored.
   */
  kind: "literal" | "ref";
  /** Stringified literal value (number, boolean, string, null). */
  value: string;
  /**
   * DISPLAY-ONLY: the constructor parameter name, e.g. "asset_".
   * Populated when the node is added from the Contracts Browser manifest.
   * This field is NOT serialized to DeploymentSpec — graph-to-spec.ts only
   * reads index / kind / value when building ContractArg.
   */
  name?: string;
  /**
   * DISPLAY-ONLY: the Solidity type of the constructor parameter, e.g.
   * "contract IERC20".
   * Populated when the node is added from the Contracts Browser manifest.
   * This field is NOT serialized to DeploymentSpec — graph-to-spec.ts only
   * reads index / kind / value when building ContractArg.
   */
  type?: string;
}

/**
 * Callbacks injected into node data so React Flow custom nodes can call them.
 *
 * Note: constructor arg slots are derived from the contract manifest when a
 * node is created (one slot per constructor parameter) and are therefore fixed
 * for the node's lifetime — there is intentionally no add/remove-slot callback.
 * Slot values are edited in place via onUpdateArgSlot.
 */
export interface NodeCallbacks {
  onUpdateDeployId: (nodeId: string, value: string) => void;
  onUpdateContractName: (nodeId: string, value: string) => void;
  onUpdateArgSlot: (nodeId: string, slotIndex: number, value: string) => void;
}

/**
 * DISPLAY-ONLY: presentation mode for the canvas.
 * - "detailed" (default): all constructor arg rows visible and editable.
 * - "overview": only Deploy ID and Contract Name are shown;
 *               constructor arg rows are collapsed (height:0/overflow:hidden)
 *               BUT their React Flow <Handle> elements remain mounted so edges
 *               stay anchored.
 * This value is injected into node data by App.tsx and MUST NOT reach
 * graphToSpec output (graph-to-spec.ts only reads deployId / contractName /
 * args / after / configSteps).
 */
export type ViewMode = "detailed" | "overview";

/** Data stored on each contract node. */
export interface ContractNodeData extends NodeCallbacks {
  /** Unique deployment id (e.g. "token", "registry"). */
  deployId: string;
  /** Solidity artifact / contract name (e.g. "ERC20Token"). */
  contractName: string;
  /** Ordered constructor arg slots. */
  args: ArgSlot[];
  /** Explicit ordering constraints (ids of contracts that must deploy first). */
  after: string[];
  /** Config steps attached to this contract node. */
  configSteps: StudioConfigStep[];
  /**
   * DISPLAY-ONLY: maps arg slot index → source node's deployId for slots that
   * are bound by an incoming constructorRef edge (slot kind === "ref").
   * Populated in App.tsx by scanning edges + nodes; recomputed reactively on
   * any nodes/edges change. NOT serialized by graph-to-spec.ts.
   *
   * When a slot index is present here, the ArgRow renders the bound source
   * node's deploy-id as "{sourceDeployId}.address" (read-only).
   * When the edge is removed the slot reverts to literal (kind="literal") and
   * the entry is absent here, restoring the editable literal input.
   */
  refSourceDeployIds?: Map<number, string>;
  /**
   * DISPLAY-ONLY: current canvas presentation mode ("detailed" | "overview").
   * Injected by App.tsx into each enriched node. NOT serialized by graph-to-spec.ts.
   * Absent nodes default to "detailed".
   */
  viewMode?: ViewMode;
}

// ---- Config step shapes (studio-internal) ----------------------------------

/** A setX step attached to a node. */
export interface StudioSetXStep {
  kind: "setX";
  id: string;
  /**
   * The deploy-id of the contract this step targets.
   * Defaults to the node this step is attached to when absent.
   * When set, overrides the attached node's deployId in the exported spec.
   */
  target?: string;
  /** Name of the setter function to call (bare name, e.g. "setLimit"). */
  functionName: string;
  /**
   * Canonical signature of the selected function, e.g. "setLimit(uint256,address)".
   * Present when the function was chosen from the manifest picker (overloaded or not).
   * When the function name is unique on the target contract, graph-to-spec emits
   * the bare name in the ConfigSpec. When it is overloaded (multiple signatures share
   * the same name), the full canonical signature is emitted instead.
   * Absent for free-text function entries (fallback input path).
   */
  functionSignature?: string;
  /** Stringified args (literals only for now). */
  args: string[];
}

/** A grantRole step attached to a node. */
export interface StudioGrantRoleStep {
  kind: "grantRole";
  id: string;
  /** target is always the node this step is attached to */
  role: string;
  /**
   * The account arg: either a literal address string or a ref to another
   * contract id.
   */
  accountKind: "literal" | "ref";
  accountValue: string;
}

/** Union of all studio config steps (wire steps come from edges). */
export type StudioConfigStep = StudioSetXStep | StudioGrantRoleStep;

// ---- Edge data types -------------------------------------------------------

/** Data on a constructor-ref edge (connects source output → target arg handle). */
export interface ConstructorRefEdgeData {
  edgeKind: "constructorRef";
  /** Index of the constructor arg slot on the target node. */
  argIndex: number;
}

/** Data on a wire edge (connects source output → target input handle). */
export interface WireEdgeData {
  edgeKind: "wire";
  /** Unique step id for the WireStep this edge represents. */
  wireStepId: string;
  /** Name of the setter function on the target (into) contract. */
  wireFunction: string;
}

/** Union of all edge data variants. */
export type StudioEdgeData = ConstructorRefEdgeData | WireEdgeData;
