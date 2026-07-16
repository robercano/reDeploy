/**
 * ParametersPanel.test.tsx
 *
 * Render tests for the deployment-wide Parameters panel (issue #137):
 * declaring parameters, editing default values, declaring networks, and
 * setting per-network overrides. Mirrors the testing style of
 * config-panel-ordered.test.tsx (OrderedConfigPanel).
 */

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ParametersPanel, ParametersPanelToggle } from "../src/components/ParametersPanel.js";
import type { StudioParameter } from "../src/spec/types.js";

const btnStyle = {};
const activeBtnStyle = {};

function makeParam(overrides: Partial<StudioParameter> = {}): StudioParameter {
  return { id: "p1", name: "", defaultValue: "", networkOverrides: {}, ...overrides };
}

function baseProps(
  overrides: Partial<React.ComponentProps<typeof ParametersPanelToggle>> = {},
) {
  return {
    parameters: [] as StudioParameter[],
    networks: [] as string[],
    selectedNetwork: null as string | null,
    onAddParameter: vi.fn(),
    onRemoveParameter: vi.fn(),
    onUpdateParameter: vi.fn(),
    onUpdateParameterOverride: vi.fn(),
    onAddNetwork: vi.fn(),
    onRemoveNetwork: vi.fn(),
    onSelectNetwork: vi.fn(),
    btnStyle,
    activeBtnStyle,
    ...overrides,
  };
}

describe("ParametersPanel — basic rendering", () => {
  it("renders the panel title and an empty-state (no parameters, no networks)", () => {
    render(<ParametersPanel {...baseProps()} />);
    expect(screen.getByTestId("parameters-panel")).not.toBeNull();
    expect(screen.getByText("Parameters")).not.toBeNull();
    expect(screen.getByTestId("parameters-add-btn")).not.toBeNull();
  });

  it("renders one ParameterCard per declared parameter", () => {
    const parameters = [makeParam({ id: "p1", name: "owner" }), makeParam({ id: "p2", name: "cap" })];
    render(<ParametersPanel {...baseProps({ parameters })} />);
    expect(screen.getByTestId("parameter-card-p1")).not.toBeNull();
    expect(screen.getByTestId("parameter-card-p2")).not.toBeNull();
  });
});

describe("ParametersPanel — adding/removing a parameter", () => {
  it("calls onAddParameter when '+ Add parameter' is clicked", () => {
    const onAddParameter = vi.fn();
    render(<ParametersPanel {...baseProps({ onAddParameter })} />);
    fireEvent.click(screen.getByTestId("parameters-add-btn"));
    expect(onAddParameter).toHaveBeenCalledTimes(1);
  });

  it("calls onRemoveParameter(id) when a card's remove button is clicked", () => {
    const onRemoveParameter = vi.fn();
    const parameters = [makeParam({ id: "p1", name: "owner" })];
    render(<ParametersPanel {...baseProps({ parameters, onRemoveParameter })} />);
    fireEvent.click(screen.getByTestId("parameter-remove-p1"));
    expect(onRemoveParameter).toHaveBeenCalledWith("p1");
  });
});

describe("ParametersPanel — editing a parameter's name and default value", () => {
  it("calls onUpdateParameter(id, {name}) when the name input changes", () => {
    const onUpdateParameter = vi.fn();
    const parameters = [makeParam({ id: "p1", name: "" })];
    render(<ParametersPanel {...baseProps({ parameters, onUpdateParameter })} />);
    fireEvent.change(screen.getByLabelText("parameter-name-p1"), { target: { value: "initialOwner" } });
    expect(onUpdateParameter).toHaveBeenCalledWith("p1", { name: "initialOwner" });
  });

  it("calls onUpdateParameter(id, {defaultValue}) when the default-value input changes", () => {
    const onUpdateParameter = vi.fn();
    const parameters = [makeParam({ id: "p1", name: "owner", defaultValue: "" })];
    render(<ParametersPanel {...baseProps({ parameters, onUpdateParameter })} />);
    fireEvent.change(screen.getByLabelText("parameter-default-p1"), { target: { value: "0xabc" } });
    expect(onUpdateParameter).toHaveBeenCalledWith("p1", { defaultValue: "0xabc" });
  });
});

describe("ParametersPanel — network management", () => {
  it("calls onAddNetwork with the typed name and clears the input", () => {
    const onAddNetwork = vi.fn();
    render(<ParametersPanel {...baseProps({ onAddNetwork })} />);

    const input = screen.getByLabelText("parameters-new-network-name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "mainnet" } });
    fireEvent.click(screen.getByTestId("parameters-add-network-btn"));

    expect(onAddNetwork).toHaveBeenCalledWith("mainnet");
    expect(input.value).toBe("");
  });

  it("does not call onAddNetwork when the input is blank", () => {
    const onAddNetwork = vi.fn();
    render(<ParametersPanel {...baseProps({ onAddNetwork })} />);
    fireEvent.click(screen.getByTestId("parameters-add-network-btn"));
    expect(onAddNetwork).not.toHaveBeenCalled();
  });

  it("lists declared networks and calls onRemoveNetwork(name) on remove", () => {
    const onRemoveNetwork = vi.fn();
    render(<ParametersPanel {...baseProps({ networks: ["mainnet", "sepolia"], onRemoveNetwork })} />);

    expect(screen.getByTestId("parameters-network-mainnet")).not.toBeNull();
    expect(screen.getByTestId("parameters-network-sepolia")).not.toBeNull();

    fireEvent.click(screen.getByTestId("parameters-network-remove-mainnet"));
    expect(onRemoveNetwork).toHaveBeenCalledWith("mainnet");
  });

  it("the active-network selector lists declared networks plus a 'use default values' option", () => {
    render(<ParametersPanel {...baseProps({ networks: ["mainnet", "sepolia"] })} />);
    const select = screen.getByLabelText("parameters-selected-network") as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(["", "mainnet", "sepolia"]);
  });

  it("selecting a network calls onSelectNetwork with its name", () => {
    const onSelectNetwork = vi.fn();
    render(<ParametersPanel {...baseProps({ networks: ["mainnet"], onSelectNetwork })} />);
    fireEvent.change(screen.getByLabelText("parameters-selected-network"), { target: { value: "mainnet" } });
    expect(onSelectNetwork).toHaveBeenCalledWith("mainnet");
  });

  it("selecting the blank option calls onSelectNetwork with null", () => {
    const onSelectNetwork = vi.fn();
    render(
      <ParametersPanel {...baseProps({ networks: ["mainnet"], selectedNetwork: "mainnet", onSelectNetwork })} />,
    );
    fireEvent.change(screen.getByLabelText("parameters-selected-network"), { target: { value: "" } });
    expect(onSelectNetwork).toHaveBeenCalledWith(null);
  });
});

describe("ParametersPanel — per-network overrides", () => {
  it("does not render per-network override inputs when no networks are declared", () => {
    const parameters = [makeParam({ id: "p1", name: "owner" })];
    render(<ParametersPanel {...baseProps({ parameters, networks: [] })} />);
    expect(screen.queryByLabelText("parameter-override-p1-mainnet")).toBeNull();
  });

  it("renders one override input per declared network, per parameter", () => {
    const parameters = [makeParam({ id: "p1", name: "owner", networkOverrides: { mainnet: "0xmain" } })];
    render(<ParametersPanel {...baseProps({ parameters, networks: ["mainnet", "sepolia"] })} />);

    const mainnetInput = screen.getByLabelText("parameter-override-p1-mainnet") as HTMLInputElement;
    expect(mainnetInput.value).toBe("0xmain");
    const sepoliaInput = screen.getByLabelText("parameter-override-p1-sepolia") as HTMLInputElement;
    expect(sepoliaInput.value).toBe("");
  });

  it("renders the empty placeholder (not an inherited prototype value) for a network named after an Object.prototype member", () => {
    // Regression test: networkOverrides is a plain object, so a network named
    // "toString" (etc.) with no OWN override recorded must not resolve to the
    // inherited Object.prototype.toString function.
    const parameters = [makeParam({ id: "p1", name: "owner", networkOverrides: {} })];
    render(<ParametersPanel {...baseProps({ parameters, networks: ["toString"] })} />);

    const input = screen.getByLabelText("parameter-override-p1-toString") as HTMLInputElement;
    expect(input.value).toBe("");
  });

  it("calls onUpdateParameterOverride(id, network, value) when an override input changes", () => {
    const onUpdateParameterOverride = vi.fn();
    const parameters = [makeParam({ id: "p1", name: "owner" })];
    render(
      <ParametersPanel
        {...baseProps({ parameters, networks: ["mainnet"], onUpdateParameterOverride })}
      />,
    );
    fireEvent.change(screen.getByLabelText("parameter-override-p1-mainnet"), {
      target: { value: "0xnew" },
    });
    expect(onUpdateParameterOverride).toHaveBeenCalledWith("p1", "mainnet", "0xnew");
  });
});

describe("ParametersPanelToggle", () => {
  it("is closed by default and opens the panel on click", () => {
    render(<ParametersPanelToggle {...baseProps({ btnStyle, activeBtnStyle })} />);
    expect(screen.queryByTestId("parameters-panel")).toBeNull();

    fireEvent.click(screen.getByTestId("toggle-parameters"));
    expect(screen.getByTestId("parameters-panel")).not.toBeNull();
  });

  it("shows a count badge when parameters are declared", () => {
    const parameters = [makeParam({ id: "p1", name: "owner" }), makeParam({ id: "p2", name: "cap" })];
    render(<ParametersPanelToggle {...baseProps({ parameters, btnStyle, activeBtnStyle })} />);
    expect(screen.getByTestId("toggle-parameters").textContent).toContain("2");
  });

  it("closes the panel when clicked again", () => {
    render(<ParametersPanelToggle {...baseProps({ btnStyle, activeBtnStyle })} />);
    const toggle = screen.getByTestId("toggle-parameters");
    fireEvent.click(toggle);
    expect(screen.getByTestId("parameters-panel")).not.toBeNull();
    fireEvent.click(toggle);
    expect(screen.queryByTestId("parameters-panel")).toBeNull();
  });
});
