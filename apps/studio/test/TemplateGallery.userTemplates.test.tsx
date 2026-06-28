/**
 * TemplateGallery.userTemplates.test.tsx
 *
 * Tests for the user-templates extension of TemplateGallery:
 *   1. User templates are displayed alongside built-ins.
 *   2. User template cards have a delete button; built-ins do not.
 *   3. onDelete is called with the correct id.
 *   4. Backward-compat: existing tests still pass (no userTemplates prop).
 */

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TemplateGallery } from "../src/components/TemplateGallery";
import type { Template } from "../src/templates/types";
import { BUILTIN_TEMPLATES } from "../src/templates/builtin";

// ---------------------------------------------------------------------------
// Fixture: a simple user template
// ---------------------------------------------------------------------------

function makeUserTemplate(id: string, name: string): Template {
  return {
    id,
    name,
    description: "A user-saved template",
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

const USER_TEMPLATE_1 = makeUserTemplate("user-1", "My First Template");
const USER_TEMPLATE_2 = makeUserTemplate("user-2", "My Second Template");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderGallery(
  userTemplates: Template[] = [],
  onInstantiate = vi.fn(),
  onDelete = vi.fn(),
) {
  return render(
    <TemplateGallery
      onInstantiate={onInstantiate}
      userTemplates={userTemplates}
      onDelete={onDelete}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. User templates in gallery
// ---------------------------------------------------------------------------

describe("TemplateGallery — user templates display", () => {
  it("shows user template cards in the gallery", () => {
    renderGallery([USER_TEMPLATE_1]);
    fireEvent.click(screen.getByTestId("template-gallery-btn"));
    expect(screen.getByTestId("template-item-user-1")).not.toBeNull();
  });

  it("shows user template name", () => {
    renderGallery([USER_TEMPLATE_1]);
    fireEvent.click(screen.getByTestId("template-gallery-btn"));
    expect(screen.getByText("My First Template")).not.toBeNull();
  });

  it("shows multiple user templates", () => {
    renderGallery([USER_TEMPLATE_1, USER_TEMPLATE_2]);
    fireEvent.click(screen.getByTestId("template-gallery-btn"));
    expect(screen.getByTestId("template-item-user-1")).not.toBeNull();
    expect(screen.getByTestId("template-item-user-2")).not.toBeNull();
  });

  it("shows both built-in and user templates", () => {
    renderGallery([USER_TEMPLATE_1]);
    fireEvent.click(screen.getByTestId("template-gallery-btn"));
    // Built-in templates should still be visible
    for (const t of BUILTIN_TEMPLATES) {
      expect(screen.getByTestId(`template-item-${t.id}`)).not.toBeNull();
    }
    // User template should also be visible
    expect(screen.getByTestId("template-item-user-1")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Delete button
// ---------------------------------------------------------------------------

describe("TemplateGallery — delete button", () => {
  it("user template cards show a delete button", () => {
    renderGallery([USER_TEMPLATE_1]);
    fireEvent.click(screen.getByTestId("template-gallery-btn"));
    expect(screen.getByTestId("template-delete-user-1")).not.toBeNull();
  });

  it("built-in template cards do NOT have a delete button", () => {
    renderGallery([USER_TEMPLATE_1]);
    fireEvent.click(screen.getByTestId("template-gallery-btn"));
    const firstBuiltin = BUILTIN_TEMPLATES[0];
    expect(screen.queryByTestId(`template-delete-${firstBuiltin.id}`)).toBeNull();
  });

  it("clicking delete calls onDelete with the template id", () => {
    const onDelete = vi.fn();
    renderGallery([USER_TEMPLATE_1], vi.fn(), onDelete);
    fireEvent.click(screen.getByTestId("template-gallery-btn"));
    fireEvent.click(screen.getByTestId("template-delete-user-1"));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith("user-1");
  });

  it("clicking delete does not call onInstantiate", () => {
    const onInstantiate = vi.fn();
    const onDelete = vi.fn();
    renderGallery([USER_TEMPLATE_1], onInstantiate, onDelete);
    fireEvent.click(screen.getByTestId("template-gallery-btn"));
    fireEvent.click(screen.getByTestId("template-delete-user-1"));
    expect(onInstantiate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Instantiation of user templates
// ---------------------------------------------------------------------------

describe("TemplateGallery — instantiate user template", () => {
  it("clicking a user template card calls onInstantiate", () => {
    const onInstantiate = vi.fn();
    renderGallery([USER_TEMPLATE_1], onInstantiate);
    fireEvent.click(screen.getByTestId("template-gallery-btn"));
    fireEvent.click(screen.getByTestId("template-item-user-1"));
    expect(onInstantiate).toHaveBeenCalledTimes(1);
    expect(onInstantiate).toHaveBeenCalledWith(USER_TEMPLATE_1);
  });

  it("shows instantiation banner after selecting a user template", () => {
    renderGallery([USER_TEMPLATE_1]);
    fireEvent.click(screen.getByTestId("template-gallery-btn"));
    fireEvent.click(screen.getByTestId("template-item-user-1"));
    expect(screen.getByTestId("template-instantiated-banner")).not.toBeNull();
    expect(screen.getByTestId("template-instantiated-banner").textContent).toContain("My First Template");
  });
});

// ---------------------------------------------------------------------------
// 4. Backward compatibility (no userTemplates prop)
// ---------------------------------------------------------------------------

describe("TemplateGallery — backward compatibility", () => {
  it("renders without userTemplates prop (built-ins only)", () => {
    render(<TemplateGallery onInstantiate={vi.fn()} />);
    fireEvent.click(screen.getByTestId("template-gallery-btn"));
    for (const t of BUILTIN_TEMPLATES) {
      expect(screen.getByTestId(`template-item-${t.id}`)).not.toBeNull();
    }
  });

  it("no delete buttons when onDelete is not provided", () => {
    render(<TemplateGallery onInstantiate={vi.fn()} userTemplates={[USER_TEMPLATE_1]} />);
    fireEvent.click(screen.getByTestId("template-gallery-btn"));
    // When onDelete is undefined, no delete buttons should be rendered for user templates either
    expect(screen.queryByTestId("template-delete-user-1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. "My Templates" section header
// ---------------------------------------------------------------------------

describe("TemplateGallery — section headers", () => {
  it("shows 'My Templates' section header when user templates are present", () => {
    renderGallery([USER_TEMPLATE_1]);
    fireEvent.click(screen.getByTestId("template-gallery-btn"));
    expect(screen.getByText("My Templates")).not.toBeNull();
  });

  it("shows 'Built-in' section header when built-ins are present", () => {
    renderGallery([USER_TEMPLATE_1]);
    fireEvent.click(screen.getByTestId("template-gallery-btn"));
    expect(screen.getByText("Built-in")).not.toBeNull();
  });
});
