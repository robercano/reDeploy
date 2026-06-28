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
// Helpers
// ---------------------------------------------------------------------------

function loadFromStorage(): Template[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(USER_TEMPLATES_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as Template[];
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
