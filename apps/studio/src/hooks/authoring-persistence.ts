/**
 * authoring-persistence.ts
 *
 * localStorage persistence for the authoring canvas (issue #80): nodes,
 * edges, and the global ordered config steps are saved on every change
 * (debounced by the caller, useGraph.ts) and restored on load.
 *
 * A version tag (AUTHORING_STATE_VERSION) lets us discard stale or corrupt
 * saved state gracefully — loadPersistedState() returns null (never throws)
 * whenever localStorage is unavailable, the JSON is malformed, the version
 * doesn't match, or the shape fails validation. Callers should treat `null`
 * exactly like "nothing saved yet" and start from a blank canvas.
 *
 * This module is pure I/O + validation — no React. useGraph.ts wires it into
 * component state (lazy initial state + a debounced save effect).
 *
 * Deployment/inspector runtime state (liveView, simulate/deploy results, mode)
 * is intentionally NOT part of this module — only authoring-canvas state is
 * persisted, per issue #80's scope.
 */

import type { Node, Edge } from "@xyflow/react";
import type {
  ArgSlot,
  StudioConfigStep,
  StudioEdgeData,
  StudioOrderedConfigStep,
  StudioParameter,
} from "../spec/types.js";

// ---------------------------------------------------------------------------
// Storage key + version
// ---------------------------------------------------------------------------

export const AUTHORING_STORAGE_KEY = "redeploy.studio.authoringState";

/**
 * Bump this whenever the persisted shape changes in a way older saved data
 * can't be safely reinterpreted as. loadPersistedState() discards anything
 * whose version doesn't match exactly (no migration) — see module doc.
 */
export const AUTHORING_STATE_VERSION = 1;

// ---------------------------------------------------------------------------
// Persisted shape
// ---------------------------------------------------------------------------

/** The serializable payload of a node (mirrors ContractNodePayload, no callbacks). */
export interface PersistedNodeData {
  deployId: string;
  contractName: string;
  args: ArgSlot[];
  after: string[];
  configSteps: StudioConfigStep[];
}

export interface PersistedNode {
  id: string;
  position: { x: number; y: number };
  data: PersistedNodeData;
}

export interface PersistedEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle: string | null;
  targetHandle: string | null;
  data?: StudioEdgeData;
}

export interface PersistedState {
  version: number;
  nodes: PersistedNode[];
  edges: PersistedEdge[];
  orderedSteps: StudioOrderedConfigStep[];
  /**
   * Deployment-wide parameter declarations (issue #137), optional for
   * backward compatibility with state saved before this field existed —
   * absent means "no parameters declared" (useGraph.ts defaults to []).
   */
  parameters?: StudioParameter[];
  /**
   * Declared network names for the Parameters panel's per-network override
   * columns (issue #137), optional for the same backward-compat reason.
   */
  networks?: string[];
  /**
   * The currently-selected network in the Parameters panel (issue #137), or
   * null for "no network selected". Optional/absent defaults to null.
   */
  selectedNetwork?: string | null;
}

// ---------------------------------------------------------------------------
// Validation (defensive — never throws, discards anything malformed)
// ---------------------------------------------------------------------------

function isArgSlot(v: unknown): v is ArgSlot {
  if (v === null || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  if (typeof s["index"] !== "number") return false;
  if (typeof s["value"] !== "string") return false;
  const kind = s["kind"];
  if (kind !== "literal" && kind !== "ref" && kind !== "param" && kind !== "expr" && kind !== "resolver") {
    return false;
  }
  // Kind-specific fields (issue #137) — optional, but must be well-typed when present.
  if (s["paramName"] !== undefined && typeof s["paramName"] !== "string") return false;
  if (s["expression"] !== undefined && typeof s["expression"] !== "string") return false;
  if (s["resolverName"] !== undefined && typeof s["resolverName"] !== "string") return false;
  if (
    s["resolverArgs"] !== undefined &&
    (!Array.isArray(s["resolverArgs"]) || !s["resolverArgs"].every((a) => typeof a === "string"))
  ) {
    return false;
  }
  return true;
}

/** Structural check for a StudioParameter (issue #137) — see spec/types.ts. */
function isStudioParameter(v: unknown): v is StudioParameter {
  if (v === null || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  if (typeof p["id"] !== "string") return false;
  if (typeof p["name"] !== "string") return false;
  if (typeof p["defaultValue"] !== "string") return false;
  if (p["networkOverrides"] === null || typeof p["networkOverrides"] !== "object") return false;
  return Object.values(p["networkOverrides"] as Record<string, unknown>).every(
    (val) => typeof val === "string",
  );
}

/**
 * Structural check only (mirrors useUserTemplates.ts's isValidTemplate
 * permissiveness) — deep arg/field validation of config steps is left to
 * graph-to-spec.ts's downstream validators. We only need enough shape
 * checking here to guarantee `.map`/`.filter` calls elsewhere never throw.
 */
function isConfigStepShape(v: unknown): v is StudioConfigStep {
  if (v === null || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  if (typeof s["id"] !== "string") return false;
  if (s["kind"] === "setX") {
    return typeof s["functionName"] === "string" && Array.isArray(s["args"]);
  }
  if (s["kind"] === "grantRole") {
    return typeof s["role"] === "string" && typeof s["accountValue"] === "string";
  }
  return false;
}

function isPersistedNode(v: unknown): v is PersistedNode {
  if (v === null || typeof v !== "object") return false;
  const n = v as Record<string, unknown>;
  if (typeof n["id"] !== "string") return false;
  if (n["position"] === null || typeof n["position"] !== "object") return false;
  const pos = n["position"] as Record<string, unknown>;
  if (typeof pos["x"] !== "number" || typeof pos["y"] !== "number") return false;
  if (n["data"] === null || typeof n["data"] !== "object") return false;
  const d = n["data"] as Record<string, unknown>;
  if (typeof d["deployId"] !== "string") return false;
  if (typeof d["contractName"] !== "string") return false;
  if (!Array.isArray(d["args"]) || !d["args"].every(isArgSlot)) return false;
  if (!Array.isArray(d["after"]) || !d["after"].every((a) => typeof a === "string")) return false;
  if (!Array.isArray(d["configSteps"]) || !d["configSteps"].every(isConfigStepShape)) return false;
  return true;
}

function isPersistedEdge(v: unknown): v is PersistedEdge {
  if (v === null || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  if (typeof e["id"] !== "string") return false;
  if (typeof e["source"] !== "string") return false;
  if (typeof e["target"] !== "string") return false;
  if (
    e["sourceHandle"] !== null &&
    e["sourceHandle"] !== undefined &&
    typeof e["sourceHandle"] !== "string"
  ) {
    return false;
  }
  if (
    e["targetHandle"] !== null &&
    e["targetHandle"] !== undefined &&
    typeof e["targetHandle"] !== "string"
  ) {
    return false;
  }
  return true;
}

function isPersistedState(v: unknown): v is PersistedState {
  if (v === null || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  if (s["version"] !== AUTHORING_STATE_VERSION) return false;
  if (!Array.isArray(s["nodes"]) || !s["nodes"].every(isPersistedNode)) return false;
  if (!Array.isArray(s["edges"]) || !s["edges"].every(isPersistedEdge)) return false;
  if (!Array.isArray(s["orderedSteps"]) || !s["orderedSteps"].every(isConfigStepShape)) {
    return false;
  }
  // Issue #137 fields — optional (backward-compat with pre-existing saved state).
  if (s["parameters"] !== undefined) {
    if (!Array.isArray(s["parameters"]) || !s["parameters"].every(isStudioParameter)) return false;
  }
  if (s["networks"] !== undefined) {
    if (!Array.isArray(s["networks"]) || !s["networks"].every((n) => typeof n === "string")) {
      return false;
    }
  }
  if (
    s["selectedNetwork"] !== undefined &&
    s["selectedNetwork"] !== null &&
    typeof s["selectedNetwork"] !== "string"
  ) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Load / save / clear
// ---------------------------------------------------------------------------

/**
 * Load and validate the persisted authoring state from localStorage.
 *
 * Returns null when there is nothing saved, localStorage is unavailable
 * (SSR / disabled / private browsing), the JSON is corrupt, the version tag
 * doesn't match, or the shape fails validation — callers should treat null
 * the same as "no saved state" and start from a blank canvas.
 */
export function loadPersistedState(): PersistedState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(AUTHORING_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isPersistedState(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Persist the given graph state, stamped with the current version. Best-effort.
 *
 * `parameters` / `networks` / `selectedNetwork` (issue #137) are optional
 * with empty/null defaults so every pre-existing call site (which only ever
 * passed nodes/edges/orderedSteps) continues to compile and behave exactly
 * as before.
 */
export function savePersistedState(
  nodes: Node<Record<string, unknown>>[],
  edges: Edge<Record<string, unknown>>[],
  orderedSteps: StudioOrderedConfigStep[],
  parameters: StudioParameter[] = [],
  networks: string[] = [],
  selectedNetwork: string | null = null,
): void {
  if (typeof window === "undefined") return;
  try {
    const state: PersistedState = {
      version: AUTHORING_STATE_VERSION,
      nodes: nodes.map((n) => {
        const d = n.data as unknown as PersistedNodeData;
        return {
          id: n.id,
          position: { x: n.position.x, y: n.position.y },
          data: {
            deployId: d.deployId,
            contractName: d.contractName,
            args: d.args,
            after: d.after,
            configSteps: d.configSteps,
          },
        };
      }),
      edges: edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle ?? null,
        targetHandle: e.targetHandle ?? null,
        ...(e.data ? { data: e.data as unknown as StudioEdgeData } : {}),
      })),
      orderedSteps,
      parameters,
      networks,
      selectedNetwork,
    };
    window.localStorage.setItem(AUTHORING_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage may be full, disabled, or unavailable (private browsing) —
    // autosave is best-effort; silently ignore.
  }
}

/** Remove the persisted authoring state entirely (used by "New / Clear canvas"). */
export function clearPersistedState(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(AUTHORING_STORAGE_KEY);
  } catch {
    // ignore
  }
}
