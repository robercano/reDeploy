import "@testing-library/jest-dom";
import { beforeEach } from "vitest";

// Polyfill ResizeObserver for jsdom — React Flow uses it internally
class ResizeObserverPolyfill {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (typeof window !== "undefined" && !window.ResizeObserver) {
  window.ResizeObserver = ResizeObserverPolyfill;
}

// Global localStorage isolation (issue #80): App now autosaves authoring
// state to localStorage (debounced). Without this, a test that mounts <App/>
// and waits long enough for the debounce to fire could leak state into a
// LATER test within the same file (jsdom's localStorage persists across
// `it()` blocks in one file even though testing-library unmounts components
// between them). Individual suites (e.g. useUserTemplates.test.ts) already
// clear localStorage themselves for their own keys; this is a blanket
// backstop so every test starts from a clean slate regardless of key.
beforeEach(() => {
  window.localStorage.clear();
});
