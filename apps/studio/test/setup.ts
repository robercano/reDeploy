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

// Polyfill Blob.prototype.text() for jsdom — jsdom implements Blob/File but not
// the async read helpers (text/arrayBuffer/stream). The snapshot loader (issue
// #105) reads an uploaded file via `file.text()`, which is standard in every
// target browser but absent under jsdom. Implement it on top of FileReader,
// which jsdom DOES support, so File objects created in tests behave like the
// browser. (File extends Blob, so this covers both.)
if (typeof Blob !== "undefined" && typeof Blob.prototype.text !== "function") {
  Blob.prototype.text = function text(this: Blob): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this);
    });
  };
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
