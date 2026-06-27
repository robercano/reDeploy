/**
 * TemplateGallery.test.tsx
 *
 * Component tests for TemplateGallery: button, modal open/close, template
 * selection, param checklist display.
 *
 * Mirrors SpecExporter.test.tsx style (render + fireEvent + data-testid).
 */

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { TemplateGallery } from "../src/components/TemplateGallery";
import { BUILTIN_TEMPLATES } from "../src/templates/builtin";
import type { Template } from "../src/templates/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderGallery(onInstantiate = vi.fn()) {
  return render(<TemplateGallery onInstantiate={onInstantiate} />);
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

describe("TemplateGallery — button", () => {
  it("renders the Templates trigger button", () => {
    renderGallery();
    expect(screen.getByTestId("template-gallery-btn")).not.toBeNull();
  });

  it("does not render modal initially", () => {
    renderGallery();
    expect(screen.queryByTestId("template-gallery-modal")).toBeNull();
  });

  it("button text is 'Templates'", () => {
    renderGallery();
    expect(screen.getByTestId("template-gallery-btn").textContent).toBe("Templates");
  });
});

// ---------------------------------------------------------------------------
// Modal open/close
// ---------------------------------------------------------------------------

describe("TemplateGallery — modal", () => {
  it("opens modal when Templates button clicked", () => {
    renderGallery();
    fireEvent.click(screen.getByTestId("template-gallery-btn"));
    expect(screen.getByTestId("template-gallery-modal")).not.toBeNull();
  });

  it("closes modal when Close button clicked", () => {
    renderGallery();
    fireEvent.click(screen.getByTestId("template-gallery-btn"));
    fireEvent.click(screen.getByTestId("template-gallery-close"));
    expect(screen.queryByTestId("template-gallery-modal")).toBeNull();
  });

  it("modal lists all built-in templates", () => {
    renderGallery();
    fireEvent.click(screen.getByTestId("template-gallery-btn"));
    for (const t of BUILTIN_TEMPLATES) {
      expect(screen.getByTestId(`template-item-${t.id}`)).not.toBeNull();
    }
  });

  it("modal shows template names", () => {
    renderGallery();
    fireEvent.click(screen.getByTestId("template-gallery-btn"));
    for (const t of BUILTIN_TEMPLATES) {
      expect(screen.getByText(t.name)).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Template selection
// ---------------------------------------------------------------------------

describe("TemplateGallery — template selection", () => {
  it("calls onInstantiate when a template is clicked", () => {
    const onInstantiate = vi.fn();
    renderGallery(onInstantiate);
    fireEvent.click(screen.getByTestId("template-gallery-btn"));

    const firstTemplate = BUILTIN_TEMPLATES[0];
    fireEvent.click(screen.getByTestId(`template-item-${firstTemplate.id}`));

    expect(onInstantiate).toHaveBeenCalledTimes(1);
    expect(onInstantiate).toHaveBeenCalledWith(firstTemplate);
  });

  it("shows instantiation banner after choosing a template", () => {
    renderGallery();
    fireEvent.click(screen.getByTestId("template-gallery-btn"));
    const firstTemplate = BUILTIN_TEMPLATES[0];
    fireEvent.click(screen.getByTestId(`template-item-${firstTemplate.id}`));
    expect(screen.getByTestId("template-instantiated-banner")).not.toBeNull();
  });

  it("shows template name in the instantiation banner", () => {
    renderGallery();
    fireEvent.click(screen.getByTestId("template-gallery-btn"));
    const firstTemplate = BUILTIN_TEMPLATES[0];
    fireEvent.click(screen.getByTestId(`template-item-${firstTemplate.id}`));
    expect(
      screen.getByTestId("template-instantiated-banner").textContent,
    ).toContain(firstTemplate.name);
  });

  it("shows param checklist after choosing a template with params", () => {
    renderGallery();
    fireEvent.click(screen.getByTestId("template-gallery-btn"));
    const templateWithParams = BUILTIN_TEMPLATES.find((t) => t.params.length > 0)!;
    fireEvent.click(screen.getByTestId(`template-item-${templateWithParams.id}`));
    expect(screen.getByTestId("template-params-list")).not.toBeNull();
  });

  it("param checklist shows param labels", () => {
    renderGallery();
    fireEvent.click(screen.getByTestId("template-gallery-btn"));
    const templateWithParams = BUILTIN_TEMPLATES.find((t) => t.params.length > 0)!;
    fireEvent.click(screen.getByTestId(`template-item-${templateWithParams.id}`));
    for (const p of templateWithParams.params) {
      expect(screen.getByText(p.label)).not.toBeNull();
    }
  });

  it("'Add Another Template' button returns to template list", () => {
    renderGallery();
    fireEvent.click(screen.getByTestId("template-gallery-btn"));
    const firstTemplate = BUILTIN_TEMPLATES[0];
    fireEvent.click(screen.getByTestId(`template-item-${firstTemplate.id}`));
    // Banner should be visible
    expect(screen.getByTestId("template-instantiated-banner")).not.toBeNull();
    // Click "Add Another Template"
    fireEvent.click(screen.getByTestId("template-gallery-add-another"));
    // Should return to template list (banner gone, template items visible again)
    expect(screen.queryByTestId("template-instantiated-banner")).toBeNull();
    expect(screen.getByTestId(`template-item-${firstTemplate.id}`)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ERC4626 Vault Stack specific
// ---------------------------------------------------------------------------

describe("TemplateGallery — ERC4626 Vault Stack template", () => {
  it("ERC4626 template card is rendered", () => {
    renderGallery();
    fireEvent.click(screen.getByTestId("template-gallery-btn"));
    expect(screen.getByTestId("template-item-erc4626-vault-stack")).not.toBeNull();
  });

  it("ERC4626 template shows 'ERC4626 Vault Stack' as name", () => {
    renderGallery();
    fireEvent.click(screen.getByTestId("template-gallery-btn"));
    expect(screen.getByText("ERC4626 Vault Stack")).not.toBeNull();
  });

  it("after instantiating ERC4626, param list shows Token name label", () => {
    renderGallery();
    fireEvent.click(screen.getByTestId("template-gallery-btn"));
    fireEvent.click(screen.getByTestId("template-item-erc4626-vault-stack"));
    // "Token name" is one of the params
    expect(screen.getByText("Token name")).not.toBeNull();
  });

  it("after instantiating ERC4626, param list shows Oracle decimals label", () => {
    renderGallery();
    fireEvent.click(screen.getByTestId("template-gallery-btn"));
    fireEvent.click(screen.getByTestId("template-item-erc4626-vault-stack"));
    expect(screen.getByText("Oracle decimals")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Keyboard navigation
// ---------------------------------------------------------------------------

describe("TemplateGallery — keyboard navigation", () => {
  it("pressing Enter on a template card calls onInstantiate", () => {
    const onInstantiate = vi.fn();
    renderGallery(onInstantiate);
    fireEvent.click(screen.getByTestId("template-gallery-btn"));
    const firstTemplate = BUILTIN_TEMPLATES[0];
    const card = screen.getByTestId(`template-item-${firstTemplate.id}`);
    fireEvent.keyDown(card, { key: "Enter" });
    expect(onInstantiate).toHaveBeenCalledTimes(1);
    expect(onInstantiate).toHaveBeenCalledWith(firstTemplate);
  });

  it("pressing Space on a template card calls onInstantiate", () => {
    const onInstantiate = vi.fn();
    renderGallery(onInstantiate);
    fireEvent.click(screen.getByTestId("template-gallery-btn"));
    const firstTemplate = BUILTIN_TEMPLATES[0];
    const card = screen.getByTestId(`template-item-${firstTemplate.id}`);
    fireEvent.keyDown(card, { key: " " });
    expect(onInstantiate).toHaveBeenCalledTimes(1);
  });

  it("pressing a different key does not call onInstantiate", () => {
    const onInstantiate = vi.fn();
    renderGallery(onInstantiate);
    fireEvent.click(screen.getByTestId("template-gallery-btn"));
    const firstTemplate = BUILTIN_TEMPLATES[0];
    const card = screen.getByTestId(`template-item-${firstTemplate.id}`);
    fireEvent.keyDown(card, { key: "Tab" });
    expect(onInstantiate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// onInstantiate receives correct template object
// ---------------------------------------------------------------------------

describe("TemplateGallery — onInstantiate signature", () => {
  it("onInstantiate is called with a valid Template object (has id, name, nodes, edges, params)", () => {
    const onInstantiate = vi.fn();
    renderGallery(onInstantiate);
    fireEvent.click(screen.getByTestId("template-gallery-btn"));
    const firstTemplate = BUILTIN_TEMPLATES[0];
    fireEvent.click(screen.getByTestId(`template-item-${firstTemplate.id}`));

    const received = onInstantiate.mock.calls[0][0] as Template;
    expect(typeof received.id).toBe("string");
    expect(typeof received.name).toBe("string");
    expect(Array.isArray(received.nodes)).toBe(true);
    expect(Array.isArray(received.edges)).toBe(true);
    expect(Array.isArray(received.params)).toBe(true);
  });
});
