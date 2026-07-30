/**
 * Tests for resolve/crossRef.ts's defense-in-depth `isAddress` guard
 * (issue #159 hardening follow-up): if a journal somehow yields a non-address
 * string for a crossRef'd contract id, resolveCrossRefArgs() must throw
 * CrossRefError("CROSS_REF_NOT_DEPLOYED") rather than substituting an
 * arbitrary string into on-chain calldata as a `{ kind: "literal" }` arg.
 *
 * This is a SEPARATE test file (rather than living in crossRef.test.ts)
 * because it needs to mock resolve/journal.js's `loadAddressesFromJournal` to
 * force a malformed value through — something a real fixture journal
 * (produced by an honest `deploy()` call, per crossRef.test.ts's strategy)
 * can never produce, since Ignition's `status()` only ever records genuine
 * deployed addresses. `vi.mock` here is file-scoped, so it doesn't affect
 * crossRef.test.ts's real-journal tests.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../src/resolve/journal.js", () => ({
  loadAddressesFromJournal: vi.fn(async () => ({ registry: "not-an-address" })),
}));

import { resolveCrossRefArgs } from "../src/resolve/crossRef.js";
import { CrossRefError } from "../src/resolve/crossRefErrors.js";
import type { DeploymentSpec } from "../src/spec/types.js";

describe("resolveCrossRefArgs — invalid-address guard (defense in depth)", () => {
  it("throws CrossRefError(CROSS_REF_NOT_DEPLOYED) when the journal's recorded value is not a valid address", async () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "vault",
          contract: "Vault",
          args: [{ kind: "crossRef", network: "mainnet", contract: "registry" }],
        },
      ],
    };

    try {
      await resolveCrossRefArgs(spec, { journals: { mainnet: { deploymentDir: "/irrelevant" } } });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CrossRefError);
      const crossRefErr = err as CrossRefError;
      expect(crossRefErr.code).toBe("CROSS_REF_NOT_DEPLOYED");
      expect(crossRefErr.message).toContain("not-an-address");
      expect(crossRefErr.message).toContain('"registry"');
    }
  });
});
