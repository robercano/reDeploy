import "@testing-library/jest-dom";

// Polyfill ResizeObserver for jsdom — React Flow uses it internally
class ResizeObserverPolyfill {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (typeof window !== "undefined" && !window.ResizeObserver) {
  window.ResizeObserver = ResizeObserverPolyfill;
}
