/**
 * useUserTemplates.ts
 *
 * React hook for persisting user-saved templates to localStorage.
 *
 * Storage key: "redeploy.studio.userTemplates"
 * Value: JSON array of Template objects.
 *
 * Defensive: guards against malformed / absent localStorage (try/catch,
 * JSON.parse fallback to []). Also SSR/no-window safe.
 */

import { useState, useCallback } from "react";
import type { Template } from "../templates/types.js";

// ---------------------------------------------------------------------------
// Storage key
// ---------------------------------------------------------------------------

export const USER_TEMPLATES_STORAGE_KEY = "redeploy.studio.userTemplates";

// ---------------------------------------------------------------------------
// Shape validation
// ---------------------------------------------------------------------------

/**
 * Type guard that validates a parsed JSON value is a well-formed Template.
 *
 * Validates all nested arrays that instantiateTemplate dereferences so that
 * a malformed/corrupt localStorage entry cannot cause an uncaught TypeError
 * inside a React event handler.
 *
 * Validation rules:
 * - t is a non-null object
 * - id, name are non-empty strings; description is a string (may be empty)
 * - nodes is an array where every element has:
 *   - string id
 *   - data object with string contractName, string deployIdSeed,
 *     array args, array after, array configSteps,
 *     and position { x: number; y: number }
 * - edges is an array where every element has string source, string target,
 *   and numeric argIndex
 * - params is an array where every element has:
 *   - non-null object
 *   - string nodeId
 *   - string label
 *   - hint, if present, must be a string
 *   - argIndex, if present, must be a number
 *   - field, if present, must be a string
 */
export function isValidTemplate(t: unknown): t is Template {
  if (t === null || typeof t !== "object") return false;
  const obj = t as Record<string, unknown>;

  if (typeof obj["id"] !== "string" || obj["id"] === "") return false;
  if (typeof obj["name"] !== "string" || obj["name"] === "") return false;
  if (typeof obj["description"] !== "string") return false;
  if (!Array.isArray(obj["nodes"])) return false;
  if (!Array.isArray(obj["edges"])) return false;
  if (!Array.isArray(obj["params"])) return false;

  for (const node of obj["nodes"] as unknown[]) {
    if (node === null || typeof node !== "object") return false;
    const n = node as Record<string, unknown>;
    if (typeof n["id"] !== "string") return false;
    if (n["data"] === null || typeof n["data"] !== "object") return false;
    const d = n["data"] as Record<string, unknown>;
    if (typeof d["contractName"] !== "string") return false;
    if (typeof d["deployIdSeed"] !== "string") return false;
    if (!Array.isArray(d["args"])) return false;
    if (!Array.isArray(d["after"])) return false;
    if (!Array.isArray(d["configSteps"])) return false;
    if (d["position"] === null || typeof d["position"] !== "object") return false;
    const pos = d["position"] as Record<string, unknown>;
    if (typeof pos["x"] !== "number" || typeof pos["y"] !== "number") return false;
  }

  for (const edge of obj["edges"] as unknown[]) {
    if (edge === null || typeof edge !== "object") return false;
    const e = edge as Record<string, unknown>;
    if (typeof e["source"] !== "string") return false;
    if (typeof e["target"] !== "string") return false;
    if (typeof e["argIndex"] !== "number") return false;
  }

  for (const param of obj["params"] as unknown[]) {
    if (param === null || typeof param !== "object") return false;
    const p = param as Record<string, unknown>;
    if (typeof p["nodeId"] !== "string") return false;
    if (typeof p["label"] !== "string") return false;
    if (p["hint"] !== undefined && typeof p["hint"] !== "string") return false;
    if (p["argIndex"] !== undefined && typeof p["argIndex"] !== "number") return false;
    if (p["field"] !== undefined && typeof p["field"] !== "string") return false;
  }

  return true;
}

function loadFromStorage(): Template[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(USER_TEMPLATES_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidTemplate);
  } catch {
    return [];
  }
}

function saveToStorage(templates: Template[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(USER_TEMPLATES_STORAGE_KEY, JSON.stringify(templates));
  } catch {
    // localStorage may be full or disabled; silently ignore
  }
}

// ---------------------------------------------------------------------------
// Hook return type
// ---------------------------------------------------------------------------

export interface UseUserTemplatesReturn {
  userTemplates: Template[];
  saveTemplate: (template: Template) => void;
  deleteTemplate: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useUserTemplates(): UseUserTemplatesReturn {
  const [userTemplates, setUserTemplates] = useState<Template[]>(loadFromStorage);

  const saveTemplate = useCallback((template: Template) => {
    setUserTemplates((prev) => {
      // Replace if id already exists, otherwise append
      const exists = prev.some((t) => t.id === template.id);
      const next = exists ? prev.map((t) => (t.id === template.id ? template : t)) : [...prev, template];
      saveToStorage(next);
      return next;
    });
  }, []);

  const deleteTemplate = useCallback((id: string) => {
    setUserTemplates((prev) => {
      const next = prev.filter((t) => t.id !== id);
      saveToStorage(next);
      return next;
    });
  }, []);

  return { userTemplates, saveTemplate, deleteTemplate };
}
