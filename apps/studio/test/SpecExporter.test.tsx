/**
 * SpecExporter.test.tsx
 *
 * Tests for the SpecExporter component: tab switching, validation states,
 * textarea contents, download buttons.
 */

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SpecExporter } from "../src/components/SpecExporter";
import type { DeploymentSpec } from "@redeploy/core";
import type { ConfigSpec } from "@redeploy/config";

const validDeployment: DeploymentSpec = {
  version: 1,
  contracts: [{ id: "token", contract: "Token" }],
};

const validConfig: ConfigSpec = {
  version: 1,
  steps: [],
};

const invalidDeployment = {
  version: 1,
  contracts: [
    { id: "dup", contract: "A" },
    { id: "dup", contract: "B" },
  ],
} as DeploymentSpec;

// A config that references a non-existent contract (will fail validateConfig)
const configWithMissingRef: ConfigSpec = {
  version: 1,
  steps: [
    { kind: "wire", id: "w1", source: "nonexistent", into: "also-nonexistent", function: "set" },
  ],
};

// ---------------------------------------------------------------------------
// Button state
// ---------------------------------------------------------------------------

describe("SpecExporter — button", () => {
  it("renders export button by default", () => {
    render(<SpecExporter deployment={validDeployment} config={validConfig} />);
    expect(screen.getByTestId("export-spec-btn")).not.toBeNull();
  });

  it("does not render modal initially", () => {
    render(<SpecExporter deployment={validDeployment} config={validConfig} />);
    expect(screen.queryByTestId("spec-exporter-modal")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Modal open/close
// ---------------------------------------------------------------------------

describe("SpecExporter — modal", () => {
  it("opens modal when export button clicked", () => {
    render(<SpecExporter deployment={validDeployment} config={validConfig} />);
    fireEvent.click(screen.getByTestId("export-spec-btn"));
    expect(screen.getByTestId("spec-exporter-modal")).not.toBeNull();
  });

  it("closes modal when Close clicked", () => {
    render(<SpecExporter deployment={validDeployment} config={validConfig} />);
    fireEvent.click(screen.getByTestId("export-spec-btn"));
    fireEvent.click(screen.getByText("✕ Close"));
    expect(screen.queryByTestId("spec-exporter-modal")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Validation status
// ---------------------------------------------------------------------------

describe("SpecExporter — validation status", () => {
  it("shows deploy-valid for a valid deployment", () => {
    render(<SpecExporter deployment={validDeployment} config={validConfig} />);
    fireEvent.click(screen.getByTestId("export-spec-btn"));
    expect(screen.getByTestId("deploy-valid")).not.toBeNull();
  });

  it("shows config-valid for a valid config", () => {
    render(<SpecExporter deployment={validDeployment} config={validConfig} />);
    fireEvent.click(screen.getByTestId("export-spec-btn"));
    expect(screen.getByTestId("config-valid")).not.toBeNull();
  });

  it("shows deploy-invalid for an invalid deployment", () => {
    render(<SpecExporter deployment={invalidDeployment} config={validConfig} />);
    fireEvent.click(screen.getByTestId("export-spec-btn"));
    expect(screen.getByTestId("deploy-invalid")).not.toBeNull();
  });

  it("shows config-invalid when config has missing refs", () => {
    // Pass a valid deployment but a config with refs to nonexistent contracts
    render(<SpecExporter deployment={validDeployment} config={configWithMissingRef} />);
    fireEvent.click(screen.getByTestId("export-spec-btn"));
    expect(screen.getByTestId("config-invalid")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Textarea content
// ---------------------------------------------------------------------------

describe("SpecExporter — textarea", () => {
  it("shows deployment JSON by default", () => {
    render(<SpecExporter deployment={validDeployment} config={validConfig} />);
    fireEvent.click(screen.getByTestId("export-spec-btn"));
    const ta = screen.getByTestId("spec-textarea") as HTMLTextAreaElement;
    expect(ta.value).toContain('"contracts"');
    expect(ta.value).toContain('"token"');
  });

  it("switches to config JSON when config tab clicked", () => {
    render(<SpecExporter deployment={validDeployment} config={validConfig} />);
    fireEvent.click(screen.getByTestId("export-spec-btn"));
    fireEvent.click(screen.getByText("config.json"));
    const ta = screen.getByTestId("spec-textarea") as HTMLTextAreaElement;
    expect(ta.value).toContain('"steps"');
  });

  it("switches back to deployment JSON when deployment tab clicked", () => {
    render(<SpecExporter deployment={validDeployment} config={validConfig} />);
    fireEvent.click(screen.getByTestId("export-spec-btn"));
    // Switch to config first
    fireEvent.click(screen.getByText("config.json"));
    // Switch back to deployment
    fireEvent.click(screen.getByText("deployment.json"));
    const ta = screen.getByTestId("spec-textarea") as HTMLTextAreaElement;
    expect(ta.value).toContain('"contracts"');
  });
});

// ---------------------------------------------------------------------------
// Download buttons (mocked URL.createObjectURL)
// ---------------------------------------------------------------------------

describe("SpecExporter — download buttons", () => {
  let createObjectURLMock: ReturnType<typeof vi.fn>;
  let revokeObjectURLMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createObjectURLMock = vi.fn().mockReturnValue("blob:mock-url");
    revokeObjectURLMock = vi.fn();
    Object.defineProperty(window.URL, "createObjectURL", {
      value: createObjectURLMock,
      writable: true,
    });
    Object.defineProperty(window.URL, "revokeObjectURL", {
      value: revokeObjectURLMock,
      writable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clicking Download deployment.json invokes createObjectURL", () => {
    render(<SpecExporter deployment={validDeployment} config={validConfig} />);
    fireEvent.click(screen.getByTestId("export-spec-btn"));
    fireEvent.click(screen.getByText("Download deployment.json"));
    expect(createObjectURLMock).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLMock).toHaveBeenCalledTimes(1);
  });

  it("clicking Download config.json invokes createObjectURL", () => {
    render(<SpecExporter deployment={validDeployment} config={validConfig} />);
    fireEvent.click(screen.getByTestId("export-spec-btn"));
    fireEvent.click(screen.getByText("Download config.json"));
    expect(createObjectURLMock).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLMock).toHaveBeenCalledTimes(1);
  });
});
