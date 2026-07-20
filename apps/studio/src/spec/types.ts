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
 * - StudioReadRef { kind: "read", contract, function, args? } — a value read
 *   from a deployed contract's view/pure function (issue #147). Passes
 *   straight through to ReadArg { kind: "read", contract, function, args? }
 *   (same field names) at export time.
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

/**
 * A single constructor argument slot on a contract node.
 *
 * Mirrors core's `ContractArg` union (see `@redeploy/core/spec`'s ParamArg /
 * ExprArg / ResolverArg / RefArg / LiteralArg) plus the studio-only "ref"
 * kind (edge-bound, no core equivalent — normalized to a literal or RefArg at
 * export, see graph-to-spec.ts's buildContractArgs).
 */
export interface ArgSlot {
  /** Position index in the constructor args array. */
  index: number;
  /**
   * "literal"  — a plain JSON value entered by the user (slot.value).
   * "ref"      — filled by an incoming constructorRef edge; value is ignored.
   * "param"    — references a named parameter declared in the Parameters
   *              panel (slot.paramName) — emits ParamArg { kind: "param", name }.
   * "expr"     — a computed expression (slot.expression) — emits ExprArg
   *              { kind: "expr", expression }.
   * "resolver" — a named resolver escape-hatch (slot.resolverName +
   *              slot.resolverArgs) — emits ResolverArg { kind: "resolver", name, args? }.
   */
  kind: "literal" | "ref" | "param" | "expr" | "resolver";
  /** Stringified literal value (number, boolean, string, null). Used when kind === "literal". */
  value: string;
  /**
   * DISPLAY-ONLY: the constructor parameter name, e.g. "asset_".
   * Populated when the node is added from the Contracts Browser manifest.
   * This field is NOT serialized to DeploymentSpec — graph-to-spec.ts only
   * reads index / kind / value(+kind-specific fields) when building ContractArg.
   */
  name?: string;
  /**
   * DISPLAY-ONLY: the Solidity type of the constructor parameter, e.g.
   * "contract IERC20".
   * Populated when the node is added from the Contracts Browser manifest.
   * This field is NOT serialized to DeploymentSpec — graph-to-spec.ts only
   * reads index / kind / value(+kind-specific fields) when building ContractArg.
   */
  type?: string;
  /**
   * Used when kind === "param": the name of the declared parameter this slot
   * references (must match a name declared in the Parameters panel to avoid
   * an UNKNOWN_PARAM validation error — see ParametersPanel.tsx).
   */
  paramName?: string;
  /** Used when kind === "expr": the expression text (core's safe expression language). */
  expression?: string;
  /** Used when kind === "resolver": the resolver name (must be a key in the injected ResolverRegistry at deploy time). */
  resolverName?: string;
  /**
   * Used when kind === "resolver": positional literal args passed to the
   * resolver, each a raw string parsed via parseLiteralValue at emission
   * (same convention as free-text config-step args elsewhere in the studio).
   */
  resolverArgs?: string[];
}

/**
 * A partial update to an arg slot, as applied by NodeCallbacks.onUpdateArgSlot.
 *
 * Callers may pass either:
 * - a plain `string` (shorthand for `{ value: <string> }`, preserving the
 *   pre-existing literal-edit call shape used throughout the codebase/tests), or
 * - an `ArgSlotUpdate` object to change the slot's kind and/or any
 *   kind-specific field (paramName / expression / resolverName / resolverArgs).
 *
 * Fields are merged onto the existing slot — omitted fields are left
 * untouched (e.g. switching kind does not clear previously-entered values for
 * OTHER kinds, so switching back and forth doesn't lose data).
 */
export type ArgSlotUpdate =
  | string
  | Partial<Pick<ArgSlot, "kind" | "value" | "paramName" | "expression" | "resolverName" | "resolverArgs">>;

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
  onUpdateArgSlot: (nodeId: string, slotIndex: number, update: ArgSlotUpdate) => void;
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
 * Studio-facing "value read from a deployed contract's view/pure function"
 * arg (issue #147). Mirrors `@redeploy/config`'s `ReadArg` shape
 * ({ kind: "read", contract, function, args? }) — this type exists on the
 * studio side only so the canvas can carry the same field names 1:1 and
 * graph-to-spec.ts's normalizeStudioArg can pass them straight through
 * without any renaming.
 *
 * - `contract` is the deploy-id of the SOURCE contract to read FROM (picked
 *   from the same `deployTargets` list used by the addressRef picker).
 * - `function` is the bare name of the view/pure function to call on it
 *   (picked via the new `getViewFunctions` manifest helper).
 * - `args` are the (optional) positional args to the view call itself. v1
 *   only supports no-arg view functions from the UI (e.g. `token.decimals()`)
 *   — the picker never populates `args` — but the field is kept so the type
 *   can carry them once a nested-arg editor is added. Per `ReadArg`'s own
 *   restriction, entries here are `string | StudioAddressRef` only — never a
 *   nested `StudioReadRef` (no nested reads, matching `ReadCallArg`).
 */
export interface StudioReadRef {
  kind: "read";
  /** The deploy-id of the SOURCE contract to read FROM. */
  contract: string;
  /** The bare name of the view/pure function to call on `contract`. */
  function: string;
  /** Optional positional args to the view call (literal or addressRef only, no nested reads). */
  args?: (string | StudioAddressRef)[];
}

/**
 * A config call argument as stored in the studio's in-memory state.
 *
 * - string: a literal value (parseLiteralValue interprets it to bool/number/string/null)
 * - StudioAddressRef: an address-of-contract reference (normalized to RefArg at export)
 * - StudioReadRef: a value read from a deployed contract's view/pure function
 *   (normalized to ReadArg at export — see graph-to-spec.ts's normalizeStudioArg)
 */
export type StudioConfigArg = string | StudioAddressRef | StudioReadRef;

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

// ---- Deployment-wide parameters (issue #137) --------------------------------

/**
 * A deployment-wide parameter declaration, authored via the Parameters panel
 * (ParametersPanel.tsx) and referenced from constructor arg slots of
 * kind === "param" (see ArgSlot.paramName).
 *
 * Serializes to `DeploymentSpec.parameters[name]` — but core's `parameters`
 * field models ONLY a flat map of default values, with no notion of
 * "network". `networkOverrides` is therefore STUDIO-ONLY state: when a
 * network is selected in the Parameters panel (see useGraph's
 * `selectedNetwork`), graph-to-spec.ts's `buildParameters()` substitutes that
 * network's override value (when set) IN PLACE OF `defaultValue` for the
 * single value emitted into `DeploymentSpec.parameters[name]`. The emitted
 * spec never carries more than one value per parameter — "per-network" is a
 * studio-authoring convenience for switching which single value gets baked
 * into the exported/simulated/deployed spec, not a feature of the spec format
 * itself. See graph-to-spec.ts's buildParameters() doc for the full story,
 * and the studio module's report for why deploy-server does not (yet) wire
 * DeployOptions.deploymentParameters for a true per-network runtime override.
 */
export interface StudioParameter {
  /** Stable id for React keys / CRUD — independent of `name` (which is user-editable). */
  id: string;
  /** Parameter name — must match the name(s) referenced by any `{kind:"param"}` ArgSlot. */
  name: string;
  /** Default value (raw string, parsed via parseLiteralValue at emission time). */
  defaultValue: string;
  /** Per-network override values (raw strings), keyed by network name. Studio-only — see above. */
  networkOverrides: Record<string, string>;
}
