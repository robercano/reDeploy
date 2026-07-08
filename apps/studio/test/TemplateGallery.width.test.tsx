/**
 * TemplateGallery.width.test.tsx
 *
 * Narrow-viewport regression test for issue #114: the TemplateGallery modal
 * hard-coded `width: 560` with no viewport bound, so on narrow/mobile
 * viewports (~375-414px portrait) it overflows the screen horizontally.
 *
 * jsdom does not perform real layout (no getBoundingClientRect geometry), so
 * we cannot assert actual pixel overflow. Instead we assert the CONTRACT
 * that prevents overflow on a narrow viewport: the modal's inline width
 * style must declare a viewport-relative cap (contain "vw") rather than the
 * old unbounded fixed-pixel `560px` value. Mirrors the narrow-viewport
 * testing convention established in App.toolbar-layout.test.tsx for issue
 * #110 (setting `window.innerWidth` and asserting inline style declares a
 * viewport-tied bound).
 *
 * This test fails against the pre-fix code: the original modalStyle had
 * `width: 560` (a bare number, resolved to "560px" with no "vw" anywhere),
 * so `style.width.includes("vw")` would be false.
 */

import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { TemplateGallery } from "../src/components/TemplateGallery.js";

const ORIGINAL_INNER_WIDTH = window.innerWidth;
const NARROW_VIEWPORT_WIDTH = 375;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // Restore jsdom's default viewport width so narrow-viewport tests never
  // leak into unrelated tests run afterward in the same file/process.
  window.innerWidth = ORIGINAL_INNER_WIDTH;
});

describe("TemplateGallery — modal width bounded to narrow viewport (#114)", () => {
  beforeEach(() => {
    // Simulate a narrow phone-portrait viewport (e.g. iPhone SE / typical
    // mobile portrait widths fall in the ~375-414px range).
    window.innerWidth = NARROW_VIEWPORT_WIDTH;
  });

  it("modal inline width style declares a viewport-relative cap (contains 'vw'), not the unbounded fixed 560px value", () => {
    render(<TemplateGallery onInstantiate={vi.fn()} />);
    fireEvent.click(screen.getByTestId("template-gallery-btn"));

    const modal = screen.getByTestId("template-gallery-modal")
      .firstElementChild as HTMLElement;

    // Must NOT be the old unbounded fixed-pixel value.
    expect(modal.style.width).not.toBe("560px");

    // Must declare SOME bound tying its width to the viewport.
    expect(modal.style.width).not.toBe("");
    expect(modal.style.width).toContain("vw");

    // Must also retain the 560px ceiling of the min() so a regression that
    // dropped the desktop cap to a bare vw value cannot pass silently (#114).
    expect(modal.style.width).toContain("560px");
  });
});
