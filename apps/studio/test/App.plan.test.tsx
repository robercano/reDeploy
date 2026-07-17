/**
 * App.plan.test.tsx
 *
 * Integration tests for the "Plan" dry-run diff feature wired into App.tsx
 * (issue #101):
 * - The "Plan" toolbar button is present alongside Simulate/Deploy.
 * - Clicking it is purely local (no fetch) and switches to inspector mode,
 *   rendering <PlanView> instead of the default <Inspector>.
 * - With no known current state, every contract shows as "create" and the
 *   "no current state" note is shown.
 * - The "Deploy (real)" confirm modal shows a compact plan summary.
 * - Diffing against KNOWN current state (issue #101 review — bugfix
 *   regression coverage): a loaded snapshot, a real-deploy result, and the
 *   deliberate exclusion of a simulate result from "current state".
 */

import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import App from "../src/App.js";
import type { DeploymentSnapshot } from "@redeploy/reader";

// ---------------------------------------------------------------------------
// SSE helpers (mirrors App.simulate.test.tsx / App.deploy.test.tsx)
// ---------------------------------------------------------------------------

function enc(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function makeStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function stepFrame(id: string, contract: string, dependsOn: string[] = []): string {
  const data = { id, contract, dependsOn, address: null };
  return `event: step\ndata: ${JSON.stringify(data)}\n\n`;
}

function doneSimulateOkFrame(): string {
  return `event: done\ndata: {"success":true}\n\n`;
}

function progressFrame(): string {
  return `event: progress\ndata: {"phase":"deploying"}\n\n`;
}

interface DeployedContract {
  id: string;
  contractName: string;
  address: string | null;
  args?: unknown[];
  dependsOn?: string[];
}

function doneDeployedFrame(contracts: DeployedContract[]): string {
  const deployment = {
    contracts: contracts.map((c) => ({
      id: c.id,
      contractName: c.contractName,
      address: c.address,
      args: c.args ?? [],
      links: { dependencies: c.dependsOn ?? [], libraries: {} },
    })),
    configSteps: [],
    warnings: [],
  };
  return `event: done\ndata: ${JSON.stringify({ success: true, deployment })}\n\n`;
}

function mockFetchOk(raw: string): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(
    new Response(makeStream([enc(raw)]), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
  );
}

function jsonFile(content: unknown, name = "snapshot.json"): File {
  return new File([JSON.stringify(content)], name, { type: "application/json" });
}

/**
 * Add a contract node by name through the Contracts Browser (mirrors the
 * helper in App.simulate.test.tsx / App.deploy.test.tsx).
 */
function addNodeByName(name: string) {
  if (!screen.queryByTestId("contracts-browser")) {
    fireEvent.click(screen.getByTestId("toggle-contracts-browser"));
  }
  const browser = screen.getByTestId("contracts-browser");
  fireEvent.click(within(browser).getByTestId(`contract-row-${name}`));
}

const REGISTRY_ADDRESS = "0x0000000000000000000000000000000000000001";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("App — Plan button", () => {
  it("renders the deploy-plan-button alongside simulate/deploy in the same toolbar", () => {
    render(<App />);
    const planBtn = screen.getByTestId("deploy-plan-button");
    expect(planBtn.textContent).toBe("Plan");

    const simulateBtn = screen.getByTestId("deploy-simulate-button");
    expect(planBtn.parentElement).toBe(simulateBtn.parentElement);
  });

  it("never calls fetch — Plan is a purely local computation", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    render(<App />);
    // The studio's own mount-time GET /api/networks call (issue #139, network
    // selector) may already have registered a call by this point — capture
    // the baseline so this test only asserts that clicking Plan itself never
    // triggers an ADDITIONAL fetch call.
    const callsBeforeClick = fetchSpy.mock.calls.length;
    fireEvent.click(screen.getByTestId("deploy-plan-button"));

    expect(fetchSpy.mock.calls.length).toBe(callsBeforeClick);
  });

  it("switches to inspector mode and renders PlanView instead of the default Inspector", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-plan-button"));

    expect(screen.getByTestId("plan-view")).toBeInTheDocument();
    // The default sample Inspector canvas should not also be present.
    expect(screen.queryByTestId("inspector-config-panel")).not.toBeInTheDocument();
  });

  it("shows the 'no current state' note when nothing has been loaded/deployed yet", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-plan-button"));

    expect(screen.getByTestId("plan-no-current-state-note")).toBeInTheDocument();
  });

  it("shows an empty-graph plan (all-zero summary) when the canvas has no nodes", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-plan-button"));

    const summary = screen.getByTestId("plan-summary");
    expect(summary.textContent).toContain("0 to create");
    expect(summary.textContent).toContain("0 unchanged");
    expect(summary.textContent).toContain("0 to change");
  });

  it("classifies a freshly added contract node as 'create' (no known current state)", () => {
    render(<App />);
    addNodeByName("Registry");

    const deployIdInput = screen.getByLabelText("deploy-id") as HTMLInputElement;
    fireEvent.change(deployIdInput, { target: { value: "registry" } });

    fireEvent.click(screen.getByTestId("deploy-plan-button"));

    expect(screen.getByTestId("plan-view")).toBeInTheDocument();
    const entry = screen.getByTestId("plan-contract-registry");
    expect(entry.textContent).toContain("create");
    expect(entry.textContent).toContain("Registry");

    const summary = screen.getByTestId("plan-summary");
    expect(summary.textContent).toContain("1 to create");
  });

  it("Esc dismisses the plan view back to authoring, mirroring Simulate/Deploy (issue #111)", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-plan-button"));
    expect(screen.getByTestId("plan-view")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.getByTestId("mode-authoring")).toBeInTheDocument();
    expect(screen.queryByTestId("plan-view")).not.toBeInTheDocument();
  });
});

describe("App — Deploy (real) confirm modal plan preview", () => {
  it("shows a compact plan summary line in the confirm modal", () => {
    render(<App />);
    addNodeByName("Registry");
    const deployIdInput = screen.getByLabelText("deploy-id") as HTMLInputElement;
    fireEvent.change(deployIdInput, { target: { value: "registry" } });

    fireEvent.click(screen.getByTestId("deploy-real-button"));

    const summaryLine = screen.getByTestId("deploy-real-plan-summary");
    expect(summaryLine.textContent).toContain("1 to create");
    expect(summaryLine.textContent).toContain("0 unchanged");
    expect(summaryLine.textContent).toContain("0 to change");
  });

  it("does not block the Deploy button when the plan summary is computed", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-real-button"));

    // The confirm button remains present/clickable regardless of plan content.
    expect(screen.getByTestId("deploy-real-confirm")).not.toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Diff-against-known-state regression coverage (issue #101 review)
//
// The pure computePlan() unit tests (plan-diff.test.ts) already cover
// create/skip/change classification in isolation. These integration tests
// instead exercise `bestKnownCurrentView`'s SELECTION logic end-to-end
// through App.tsx: snapshot priority, real-deploy priority, the deliberate
// simulate exclusion, and — critically — that a real deploy's result
// survives as the diff basis across subsequent Plan clicks (the provenance
// bug: `viewKind` becomes "plan" on the very first Plan click, so anything
// keyed off `viewKind === "deploy"` breaks after that click).
// ---------------------------------------------------------------------------

describe("App — Plan diffs against a loaded snapshot (issue #101 review)", () => {
  it("loads a snapshot, clicks Plan, and renders a skip (not create) entry", async () => {
    render(<App />);
    addNodeByName("Registry");
    fireEvent.change(screen.getByLabelText("deploy-id") as HTMLInputElement, {
      target: { value: "registry" },
    });
    fireEvent.change(screen.getByLabelText("arg-0"), { target: { value: REGISTRY_ADDRESS } });

    fireEvent.click(screen.getByTestId("mode-inspector"));
    const snapshot: DeploymentSnapshot = {
      snapshotVersion: 1,
      takenAt: "2026-07-08T00:00:00.000Z",
      chainId: 1,
      toolVersion: "0.3.1",
      specHash: "abc123",
      contracts: [
        {
          id: "registry",
          contractName: "Registry",
          address: REGISTRY_ADDRESS,
          args: [REGISTRY_ADDRESS],
          links: { dependencies: [], libraries: {} },
        },
      ],
      configSteps: [],
      warnings: [],
    };
    const input = screen.getByTestId("load-snapshot-input") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [jsonFile(snapshot)] } });
    await waitFor(() => {
      expect(screen.getByTestId("snapshot-meta-panel")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("deploy-plan-button"));

    // The plan actually renders (bug #2: it previously silently no-op'd
    // while a snapshot was loaded, since PlanView was gated on
    // loadedSnapshot === null while SnapshotViewer kept winning).
    expect(screen.getByTestId("plan-view")).toBeInTheDocument();
    const entry = screen.getByTestId("plan-contract-registry");
    expect(entry.textContent).toContain("skip");
    expect(entry.textContent?.toLowerCase()).not.toContain("create");
    expect(screen.queryByTestId("plan-no-current-state-note")).not.toBeInTheDocument();
  });
});

describe("App — Deploy (real) confirm modal reflects known current state (issue #101 review)", () => {
  it("shows non-zero 'unchanged' after a prior real deploy of the same contract/args", async () => {
    render(<App />);
    addNodeByName("Registry");
    fireEvent.change(screen.getByLabelText("deploy-id") as HTMLInputElement, {
      target: { value: "registry" },
    });
    fireEvent.change(screen.getByLabelText("arg-0"), { target: { value: REGISTRY_ADDRESS } });

    const raw =
      progressFrame() +
      doneDeployedFrame([
        {
          id: "registry",
          contractName: "Registry",
          address: REGISTRY_ADDRESS,
          args: [REGISTRY_ADDRESS],
        },
      ]);
    vi.stubGlobal("fetch", mockFetchOk(raw));

    fireEvent.click(screen.getByTestId("deploy-real-button"));
    fireEvent.click(screen.getByTestId("deploy-real-confirm"));

    await waitFor(() => {
      expect(screen.queryByTestId("inspector-node-registry-address")).not.toBeNull();
    });

    // Re-open the confirm modal now that a real-deploy result is known.
    fireEvent.click(screen.getByTestId("deploy-real-button"));

    const summaryLine = screen.getByTestId("deploy-real-plan-summary");
    expect(summaryLine.textContent).toContain("0 to create");
    expect(summaryLine.textContent).toContain("1 unchanged");
    expect(summaryLine.textContent).toContain("0 to change");
  });
});

describe("App — Plan provenance survives repeated clicks after a real deploy (issue #101 review, bug #1 regression)", () => {
  it("diffs against the real-deploy view on both the first and a second (double) Plan click", async () => {
    render(<App />);
    addNodeByName("Registry");
    fireEvent.change(screen.getByLabelText("deploy-id") as HTMLInputElement, {
      target: { value: "registry" },
    });
    fireEvent.change(screen.getByLabelText("arg-0"), { target: { value: REGISTRY_ADDRESS } });

    const raw =
      progressFrame() +
      doneDeployedFrame([
        {
          id: "registry",
          contractName: "Registry",
          address: REGISTRY_ADDRESS,
          args: [REGISTRY_ADDRESS],
        },
      ]);
    vi.stubGlobal("fetch", mockFetchOk(raw));

    fireEvent.click(screen.getByTestId("deploy-real-button"));
    fireEvent.click(screen.getByTestId("deploy-real-confirm"));

    await waitFor(() => {
      expect(screen.queryByTestId("inspector-node-registry-address")).not.toBeNull();
    });

    // First Plan click after the real deploy: must diff against the deploy view.
    fireEvent.click(screen.getByTestId("deploy-plan-button"));
    expect(screen.getByTestId("plan-contract-registry").textContent).toContain("skip");
    expect(screen.queryByTestId("plan-no-current-state-note")).not.toBeInTheDocument();

    // Second (double) Plan click: `viewKind` is now "plan" from the first
    // click — this is exactly the scenario bug #1 broke (bestKnownCurrentView
    // keyed off `viewKind === "deploy"`, already overwritten to "plan" by
    // then). It must STILL diff against the deploy view, not regress to
    // showing everything as "create".
    fireEvent.click(screen.getByTestId("deploy-plan-button"));
    expect(screen.getByTestId("plan-contract-registry").textContent).toContain("skip");
    expect(screen.queryByTestId("plan-no-current-state-note")).not.toBeInTheDocument();
  });
});

describe("App — a simulate result is never treated as known current state (issue #101 review)", () => {
  it("still shows an all-create plan / 'no current state' note after Simulate then Plan", async () => {
    render(<App />);
    addNodeByName("Registry");
    fireEvent.change(screen.getByLabelText("deploy-id") as HTMLInputElement, {
      target: { value: "registry" },
    });
    fireEvent.change(screen.getByLabelText("arg-0"), { target: { value: REGISTRY_ADDRESS } });

    const raw = stepFrame("registry", "Registry", []) + doneSimulateOkFrame();
    vi.stubGlobal("fetch", mockFetchOk(raw));

    fireEvent.click(screen.getByTestId("deploy-simulate-button"));
    await waitFor(() => {
      expect(screen.queryByTestId("inspector-config-panel")).not.toBeNull();
    });

    fireEvent.click(screen.getByTestId("deploy-plan-button"));

    // A simulate view always has address: null and is intentionally NOT
    // "current state" — Plan must fall back to noCurrentState/all-create,
    // never silently diff against the simulate result.
    expect(screen.getByTestId("plan-no-current-state-note")).toBeInTheDocument();
    expect(screen.getByTestId("plan-contract-registry").textContent).toContain("create");
  });
});
