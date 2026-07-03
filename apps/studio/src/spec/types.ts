/**
 * Studio-local node and edge data types for the React Flow authoring canvas.
 *
 * These types describe the in-memory graph that the canvas stores, which is
 * then serialized to DeploymentSpec + ConfigSpec via graph-to-spec.ts.
 *
 * ## Node types
 *
 * - ContractNodeData: represents a single deployable contract. It holds the
 *   deployment id, the Solidity artifact name, a list of constructor arg slots,
 *   and per-node config call steps.
 *
 * ## Config steps
 *
 * Each contract node carries an optional list of per-node config calls
 * (StudioConfigStep). These are serialized to ConfigSpec.steps (unordered).
 * The canvas also maintains a global ordered list (StudioOrderedConfigStep[])
 * serialized to ConfigSpec.orderedSteps (globally ordered execution).
 *
 * Args in config steps (StudioConfigArg) may use:
 * - A plain string (literal value, interpreted by parseLiteralValue)
 * - StudioAddressRef { kind: "addressRef", deployId } — studio-facing only.
 *   MUST be normalized to RefArg { kind: "ref", contract: deployId } before
 *   emitting a ConfigSpec (done in graph-to-spec.ts normalizeStudioArg).
 *
 * ## Edge types
 *
 * One logical kind of edge:
 *
 * 1. ConstructorRefEdge (edgeKind = "constructorRef")
 *    source handle: "<contractId>-output"
 *    target handle: "<contractId>-arg-<index>"
 *    Maps to: ContractArg at position <index> in target ContractEntry.args →
 *             RefArg { kind: "ref", contract: <source node id> }
 *
 * Wire edges have been removed. Cross-contract wiring is now expressed as a
 * config call step whose arg is a { kind: "addressRef", deployId } reference.
 */

import type { NodeFieldErrors } from "../deploy/field-errors.js";

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
  /** Per-node config steps (serialized to ConfigSpec.steps, unordered). */
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
  /**
   * DISPLAY-ONLY: field-level / node-level validation errors from the most
   * recent Deploy (simulate) or Deploy (real) run (issue #83). Injected by
   * App.tsx via field-errors.ts's buildNodeFieldErrors, derived from the
   * structured errors returned by runSimulate/runDeploy. NOT serialized by
   * graph-to-spec.ts. Cleared when a new run starts or the run succeeds.
   */
  errors?: NodeFieldErrors;
}

// ---- Studio config arg types ------------------------------------------------

/**
 * Studio-facing address-of-contract reference arg.
 * "{deployId}.address" — must be normalized to RefArg before emitting ConfigSpec.
 *
 * This type is studio-internal ONLY. graph-to-spec.ts converts it to
 * { kind: "ref", contract: deployId } (a valid ConfigArg) before validation.
 */
export interface StudioAddressRef {
  kind: "addressRef";
  /** The deploy-id of the contract whose address is referenced. */
  deployId: string;
}

/**
 * A config call argument as stored in the studio's in-memory state.
 *
 * - string: a literal value (parseLiteralValue interprets it to bool/number/string/null)
 * - StudioAddressRef: an address-of-contract reference (normalized to RefArg at export)
 */
export type StudioConfigArg = string | StudioAddressRef;

// ---- Config step shapes (studio-internal) ----------------------------------

/** A setX step attached to a node (or in the global ordered list). */
export interface StudioSetXStep {
  kind: "setX";
  id: string;
  /**
   * The deploy-id of the contract this step targets.
   * For per-node steps: defaults to the node this step is attached to when absent.
   * For ordered steps: must always be set (there is no implicit attached-node target).
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
  /**
   * Step arguments. Each element is either a literal value string or a
   * StudioAddressRef (a { kind:"addressRef", deployId } reference that
   * graph-to-spec.ts normalizes to RefArg before export).
   */
  args: StudioConfigArg[];
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

/** Union of all studio per-node config steps. */
export type StudioConfigStep = StudioSetXStep | StudioGrantRoleStep;

/**
 * A step in the global ordered config panel.
 * These map to ConfigSpec.orderedSteps (strictly ordered execution).
 *
 * Currently only setX steps are supported in the ordered panel. GrantRole
 * steps are per-node only.
 */
export type StudioOrderedConfigStep = StudioSetXStep;

// ---- Edge data types -------------------------------------------------------

/** Data on a constructor-ref edge (connects source output → target arg handle). */
export interface ConstructorRefEdgeData {
  edgeKind: "constructorRef";
  /** Index of the constructor arg slot on the target node. */
  argIndex: number;
}

/** Union of all edge data variants (wire edges have been removed). */
export type StudioEdgeData = ConstructorRefEdgeData;
