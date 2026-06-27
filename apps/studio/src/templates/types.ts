/**
 * templates/types.ts
 *
 * Type definitions for studio built-in templates.
 *
 * A Template describes a pre-arranged set of contracts and constructor-ref
 * connections that can be dropped onto the canvas as a unit. Templates use
 * template-local node ids (e.g. "token", "oracle") that are remapped to
 * collision-free real graph ids at instantiation time.
 *
 * ## Node shape
 * TemplateNode carries the fields needed to build a ContractNodeData MINUS the
 * injected callbacks (onUpdateDeployId, etc.). Callbacks are added at
 * instantiation time, exactly like addContractNode / addContractFromManifest.
 *
 * ## Edge shape
 * TemplateEdge describes source template-local-id → target template-local-id
 * plus an argIndex for constructorRef edges. Only constructorRef edges are
 * supported in templates (wire edges can be added manually after instantiation).
 *
 * ## Params
 * Params surface which arg slots the user should fill before deploying. They
 * reference the template-local node id and the arg index. The actual editing
 * happens through the existing ContractNode UI — params are a read-only
 * checklist surfaced in the TemplateGallery after instantiation.
 */

import type { ArgSlot, StudioConfigStep } from "../spec/types.js";

// ---------------------------------------------------------------------------
// Template node (no callbacks — those are injected at instantiation)
// ---------------------------------------------------------------------------

/** The serializable payload of a template node (mirrors ContractNodePayload). */
export interface TemplateNodePayload {
  /**
   * Seed for the deployId. At instantiation, if a node with this deployId
   * already exists on the canvas, a numeric suffix is appended to avoid
   * collisions (e.g. "Token" → "Token-2").
   */
  deployIdSeed: string;
  /** Solidity artifact / contract name (e.g. "VaultERC4626"). */
  contractName: string;
  /** Ordered constructor arg slots. "ref" slots are filled by template edges. */
  args: ArgSlot[];
  /** Explicit ordering constraints (template-local ids). */
  after: string[];
  /** Config steps attached to this node. */
  configSteps: StudioConfigStep[];
  /** Canvas position offset relative to the drop origin. */
  position: { x: number; y: number };
}

/** A node in the template's node list. */
export interface TemplateNode {
  /** Template-local id (e.g. "token", "oracle", "vault"). */
  id: string;
  data: TemplateNodePayload;
}

// ---------------------------------------------------------------------------
// Template edge
// ---------------------------------------------------------------------------

/**
 * A constructorRef edge between two template nodes.
 * source → target arg at argIndex.
 */
export interface TemplateEdge {
  /** Template-local id of the source node (the contract being referenced). */
  source: string;
  /** Template-local id of the target node (the contract receiving the ref). */
  target: string;
  /** Index of the constructor arg slot on the target node being filled. */
  argIndex: number;
}

// ---------------------------------------------------------------------------
// Template params
// ---------------------------------------------------------------------------

/**
 * Describes a constructor arg slot that the user should fill before deploying.
 * References a template-local node id and an arg index (or, for future
 * extensibility, a named field like a config step field).
 */
export interface TemplateParam {
  /** Template-local node id that owns this arg slot. */
  nodeId: string;
  /** Index of the constructor arg on that node. For argIndex-based params. */
  argIndex?: number;
  /** For future non-arg params (e.g. a config step field). */
  field?: string;
  /** Human-readable label shown in the param checklist. */
  label: string;
  /** Optional hint / placeholder shown beside the label. */
  hint?: string;
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

/** A built-in template: a pre-arranged set of contracts + constructor-ref edges. */
export interface Template {
  /** Unique identifier for the template (e.g. "erc4626-vault-stack"). */
  id: string;
  /** Human-readable name (e.g. "ERC4626 Vault Stack"). */
  name: string;
  /** Short description shown in the template gallery modal. */
  description: string;
  /** Ordered list of template nodes. */
  nodes: TemplateNode[];
  /** Constructor-ref edges between template nodes. */
  edges: TemplateEdge[];
  /**
   * Params the user should fill before deploying.
   * Surfaced as a read-only checklist in the gallery after instantiation.
   */
  params: TemplateParam[];
}
