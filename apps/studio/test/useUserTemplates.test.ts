/**
 * useUserTemplates.test.ts
 *
 * Tests for useUserTemplates hook:
 *   1. save / load / delete persists to localStorage.
 *   2. Malformed storage falls back to [].
 *   3. Missing key returns [].
 *   4. SSR safe (no window crash).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useUserTemplates, USER_TEMPLATES_STORAGE_KEY } from "../src/hooks/useUserTemplates";
import type { Template } from "../src/templates/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTemplate(id: string): Template {
  return {
    id,
    name: `Template ${id}`,
    description: "A test template",
    nodes: [
      {
        id: "node-1",
        data: {
          deployIdSeed: "Token",
          contractName: "Token",
          args: [],
          after: [],
          configSteps: [],
          position: { x: 0, y: 0 },
        },
      },
    ],
    edges: [],
    params: [],
  };
}

// ---------------------------------------------------------------------------
// Setup: clear localStorage before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// 1. Initial state
// ---------------------------------------------------------------------------

describe("useUserTemplates — initial state", () => {
  it("starts with empty array when localStorage is empty", () => {
    const { result } = renderHook(() => useUserTemplates());
    expect(result.current.userTemplates).toHaveLength(0);
  });

  it("loads existing templates from localStorage on mount", () => {
    const templates = [makeTemplate("t1"), makeTemplate("t2")];
    localStorage.setItem(USER_TEMPLATES_STORAGE_KEY, JSON.stringify(templates));

    const { result } = renderHook(() => useUserTemplates());
    expect(result.current.userTemplates).toHaveLength(2);
    expect(result.current.userTemplates[0].id).toBe("t1");
    expect(result.current.userTemplates[1].id).toBe("t2");
  });
});

// ---------------------------------------------------------------------------
// 2. saveTemplate
// ---------------------------------------------------------------------------

describe("useUserTemplates — saveTemplate", () => {
  it("appends a new template to the list", () => {
    const { result } = renderHook(() => useUserTemplates());
    const tmpl = makeTemplate("user-1");

    act(() => result.current.saveTemplate(tmpl));
    expect(result.current.userTemplates).toHaveLength(1);
    expect(result.current.userTemplates[0].id).toBe("user-1");
  });

  it("persists the template to localStorage", () => {
    const { result } = renderHook(() => useUserTemplates());
    const tmpl = makeTemplate("user-1");

    act(() => result.current.saveTemplate(tmpl));

    const raw = localStorage.getItem(USER_TEMPLATES_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as Template[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("user-1");
  });

  it("saves multiple templates", () => {
    const { result } = renderHook(() => useUserTemplates());

    act(() => result.current.saveTemplate(makeTemplate("t1")));
    act(() => result.current.saveTemplate(makeTemplate("t2")));
    act(() => result.current.saveTemplate(makeTemplate("t3")));

    expect(result.current.userTemplates).toHaveLength(3);
  });

  it("replaces an existing template with the same id", () => {
    const { result } = renderHook(() => useUserTemplates());
    const original = makeTemplate("user-1");
    const updated = { ...makeTemplate("user-1"), name: "Updated Name" };

    act(() => result.current.saveTemplate(original));
    act(() => result.current.saveTemplate(updated));

    expect(result.current.userTemplates).toHaveLength(1);
    expect(result.current.userTemplates[0].name).toBe("Updated Name");
  });
});

// ---------------------------------------------------------------------------
// 3. deleteTemplate
// ---------------------------------------------------------------------------

describe("useUserTemplates — deleteTemplate", () => {
  it("removes the template with the given id", () => {
    const { result } = renderHook(() => useUserTemplates());

    act(() => result.current.saveTemplate(makeTemplate("t1")));
    act(() => result.current.saveTemplate(makeTemplate("t2")));
    act(() => result.current.deleteTemplate("t1"));

    expect(result.current.userTemplates).toHaveLength(1);
    expect(result.current.userTemplates[0].id).toBe("t2");
  });

  it("persists the deletion to localStorage", () => {
    const { result } = renderHook(() => useUserTemplates());

    act(() => result.current.saveTemplate(makeTemplate("t1")));
    act(() => result.current.saveTemplate(makeTemplate("t2")));
    act(() => result.current.deleteTemplate("t1"));

    const raw = localStorage.getItem(USER_TEMPLATES_STORAGE_KEY);
    const parsed = JSON.parse(raw!) as Template[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("t2");
  });

  it("deleting a non-existent id does nothing", () => {
    const { result } = renderHook(() => useUserTemplates());

    act(() => result.current.saveTemplate(makeTemplate("t1")));
    act(() => result.current.deleteTemplate("does-not-exist"));

    expect(result.current.userTemplates).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Malformed storage fallback
// ---------------------------------------------------------------------------

describe("useUserTemplates — malformed storage", () => {
  it("falls back to [] when localStorage contains invalid JSON", () => {
    localStorage.setItem(USER_TEMPLATES_STORAGE_KEY, "NOT VALID JSON {{{");
    const { result } = renderHook(() => useUserTemplates());
    expect(result.current.userTemplates).toHaveLength(0);
  });

  it("falls back to [] when localStorage contains a non-array value", () => {
    localStorage.setItem(USER_TEMPLATES_STORAGE_KEY, JSON.stringify({ not: "an array" }));
    const { result } = renderHook(() => useUserTemplates());
    expect(result.current.userTemplates).toHaveLength(0);
  });

  it("falls back to [] when the key is absent", () => {
    // localStorage is already cleared in beforeEach
    const { result } = renderHook(() => useUserTemplates());
    expect(result.current.userTemplates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Persistence across hook remounts
// ---------------------------------------------------------------------------

describe("useUserTemplates — persistence across remounts", () => {
  it("newly mounted hook reads templates saved by a previous mount", () => {
    const { result: first } = renderHook(() => useUserTemplates());
    act(() => first.current.saveTemplate(makeTemplate("persisted-1")));

    // Unmount and remount
    const { result: second } = renderHook(() => useUserTemplates());
    expect(second.current.userTemplates).toHaveLength(1);
    expect(second.current.userTemplates[0].id).toBe("persisted-1");
  });
});

// ---------------------------------------------------------------------------
// 6. isValidTemplate shape guard (malformed entries filtered out)
// ---------------------------------------------------------------------------

import { isValidTemplate } from "../src/hooks/useUserTemplates";

describe("useUserTemplates — malformed element filtering", () => {
  it("filters out an entry missing nodes", () => {
    const bad = { id: "t1", name: "Bad", description: "", edges: [], params: [] };
    localStorage.setItem(USER_TEMPLATES_STORAGE_KEY, JSON.stringify([bad, makeTemplate("good")]));
    const { result } = renderHook(() => useUserTemplates());
    expect(result.current.userTemplates).toHaveLength(1);
    expect(result.current.userTemplates[0].id).toBe("good");
  });

  it("filters out an entry where nodes is not an array", () => {
    const bad = { id: "t2", name: "Bad", description: "", nodes: "not-an-array", edges: [], params: [] };
    localStorage.setItem(USER_TEMPLATES_STORAGE_KEY, JSON.stringify([bad, makeTemplate("good")]));
    const { result } = renderHook(() => useUserTemplates());
    expect(result.current.userTemplates).toHaveLength(1);
    expect(result.current.userTemplates[0].id).toBe("good");
  });

  it("filters out an entry where a node is missing data", () => {
    const bad = {
      id: "t3",
      name: "Bad",
      description: "",
      nodes: [{ id: "node-1" }], // missing data
      edges: [],
      params: [],
    };
    localStorage.setItem(USER_TEMPLATES_STORAGE_KEY, JSON.stringify([bad, makeTemplate("good")]));
    const { result } = renderHook(() => useUserTemplates());
    expect(result.current.userTemplates).toHaveLength(1);
    expect(result.current.userTemplates[0].id).toBe("good");
  });

  it("filters out an entry where a node data is missing args array", () => {
    const bad = {
      id: "t4",
      name: "Bad",
      description: "",
      nodes: [
        {
          id: "node-1",
          data: {
            deployIdSeed: "Token",
            contractName: "Token",
            // args missing
            after: [],
            configSteps: [],
            position: { x: 0, y: 0 },
          },
        },
      ],
      edges: [],
      params: [],
    };
    localStorage.setItem(USER_TEMPLATES_STORAGE_KEY, JSON.stringify([bad, makeTemplate("good")]));
    const { result } = renderHook(() => useUserTemplates());
    expect(result.current.userTemplates).toHaveLength(1);
    expect(result.current.userTemplates[0].id).toBe("good");
  });

  it("does not throw when loading a stored array with malformed elements", () => {
    const entries = [
      null,
      42,
      "string",
      { id: "", name: "no-id", description: "", nodes: [], edges: [], params: [] }, // empty id
      makeTemplate("valid"),
    ];
    localStorage.setItem(USER_TEMPLATES_STORAGE_KEY, JSON.stringify(entries));
    expect(() => renderHook(() => useUserTemplates())).not.toThrow();
    const { result } = renderHook(() => useUserTemplates());
    expect(result.current.userTemplates).toHaveLength(1);
    expect(result.current.userTemplates[0].id).toBe("valid");
  });

  it("valid siblings survive when malformed entries are filtered out", () => {
    const entries = [
      makeTemplate("valid-1"),
      { id: "bad", name: "Bad", description: "", nodes: "oops", edges: [], params: [] },
      makeTemplate("valid-2"),
    ];
    localStorage.setItem(USER_TEMPLATES_STORAGE_KEY, JSON.stringify(entries));
    const { result } = renderHook(() => useUserTemplates());
    expect(result.current.userTemplates).toHaveLength(2);
    expect(result.current.userTemplates.map((t) => t.id)).toEqual(["valid-1", "valid-2"]);
  });

  it("isValidTemplate returns false for non-object values", () => {
    expect(isValidTemplate(null)).toBe(false);
    expect(isValidTemplate(42)).toBe(false);
    expect(isValidTemplate("string")).toBe(false);
    expect(isValidTemplate([])).toBe(false);
  });

  it("isValidTemplate returns true for a well-formed template", () => {
    expect(isValidTemplate(makeTemplate("t1"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. params element validation (regression for corrupt-localStorage crash)
// ---------------------------------------------------------------------------

describe("useUserTemplates — params element filtering", () => {
  it("filters out a template with params: [null] and keeps a valid sibling", () => {
    const bad = { ...makeTemplate("bad"), params: [null] };
    const good = makeTemplate("good");
    localStorage.setItem(USER_TEMPLATES_STORAGE_KEY, JSON.stringify([bad, good]));
    expect(() => renderHook(() => useUserTemplates())).not.toThrow();
    const { result } = renderHook(() => useUserTemplates());
    expect(result.current.userTemplates).toHaveLength(1);
    expect(result.current.userTemplates[0].id).toBe("good");
  });

  it("filters out a template with params: ['bad'] (string element) and keeps a valid sibling", () => {
    const bad = { ...makeTemplate("bad"), params: ["bad"] };
    const good = makeTemplate("good");
    localStorage.setItem(USER_TEMPLATES_STORAGE_KEY, JSON.stringify([bad, good]));
    expect(() => renderHook(() => useUserTemplates())).not.toThrow();
    const { result } = renderHook(() => useUserTemplates());
    expect(result.current.userTemplates).toHaveLength(1);
    expect(result.current.userTemplates[0].id).toBe("good");
  });

  it("filters out a template with params: [{}] (missing required nodeId/label) and keeps a valid sibling", () => {
    const bad = { ...makeTemplate("bad"), params: [{}] };
    const good = makeTemplate("good");
    localStorage.setItem(USER_TEMPLATES_STORAGE_KEY, JSON.stringify([bad, good]));
    expect(() => renderHook(() => useUserTemplates())).not.toThrow();
    const { result } = renderHook(() => useUserTemplates());
    expect(result.current.userTemplates).toHaveLength(1);
    expect(result.current.userTemplates[0].id).toBe("good");
  });

  it("accepts a template with well-formed param elements", () => {
    const good = {
      ...makeTemplate("good"),
      params: [
        { nodeId: "node-1", label: "Token Name", hint: "e.g. MyToken", argIndex: 0 },
        { nodeId: "node-1", label: "Token Symbol" },
        { nodeId: "node-1", label: "Config Field", field: "symbol" },
      ],
    };
    localStorage.setItem(USER_TEMPLATES_STORAGE_KEY, JSON.stringify([good]));
    const { result } = renderHook(() => useUserTemplates());
    expect(result.current.userTemplates).toHaveLength(1);
    expect(result.current.userTemplates[0].id).toBe("good");
  });

  it("isValidTemplate returns false when params contains null", () => {
    const t = { ...makeTemplate("t1"), params: [null] };
    expect(isValidTemplate(t)).toBe(false);
  });

  it("isValidTemplate returns false when params contains a string element", () => {
    const t = { ...makeTemplate("t1"), params: ["bad"] };
    expect(isValidTemplate(t)).toBe(false);
  });

  it("isValidTemplate returns false when params element is missing nodeId", () => {
    const t = { ...makeTemplate("t1"), params: [{ label: "Token Name" }] };
    expect(isValidTemplate(t)).toBe(false);
  });

  it("isValidTemplate returns false when params element is missing label", () => {
    const t = { ...makeTemplate("t1"), params: [{ nodeId: "node-1" }] };
    expect(isValidTemplate(t)).toBe(false);
  });

  it("isValidTemplate returns false when hint is not a string", () => {
    const t = { ...makeTemplate("t1"), params: [{ nodeId: "node-1", label: "Name", hint: 42 }] };
    expect(isValidTemplate(t)).toBe(false);
  });

  it("isValidTemplate returns false when argIndex is not a number", () => {
    const t = { ...makeTemplate("t1"), params: [{ nodeId: "node-1", label: "Name", argIndex: "0" }] };
    expect(isValidTemplate(t)).toBe(false);
  });

  it("isValidTemplate returns false when field is not a string", () => {
    const t = { ...makeTemplate("t1"), params: [{ nodeId: "node-1", label: "Name", field: 99 }] };
    expect(isValidTemplate(t)).toBe(false);
  });
});
