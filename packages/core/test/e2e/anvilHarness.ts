/**
 * Anvil process harness for @redeploy/core end-to-end tests.
 *
 * These e2e tests exercise deploy() against a REAL local Anvil chain (not a
 * mocked EIP-1193 provider) to prove the idempotent-resume guarantee holds
 * against real JSON-RPC semantics, real transaction receipts, and real
 * on-chain bytecode.
 *
 * See `test/e2e/README.md` for how to run these tests and why they are kept
 * out of the default (fast, network-free) `test` script.
 *
 * DESIGN
 * ======
 * - `isAnvilAvailable()` probes for the `anvil` binary (spawnSync --version).
 *   Callers MUST check this and `describe.skip`/`it.skip` with a clear message
 *   when unavailable — these tests are never allowed to silently no-op the
 *   gate; skipping must be visible in the test report.
 * - `startAnvil()` spawns a fresh anvil instance on a RANDOMIZED port (never
 *   the default 8545) to avoid collisions with other anvil instances (CI
 *   workers, developer machines, other test files running in parallel).
 *   On a bind conflict it retries with a new random port up to
 *   MAX_START_ATTEMPTS times.
 * - Readiness is detected by polling `eth_chainId` over the real HTTP
 *   transport (via viem, consistent with how the rest of @redeploy/core talks
 *   to JSON-RPC endpoints — see ../../src/provider/jsonRpc.ts) until it
 *   responds or a timeout elapses.
 * - Anvil's `--config-out <file>` flag is used to read back the deterministic
 *   dev accounts + private keys for the running instance rather than
 *   hardcoding them, so the harness stays correct even if anvil's default
 *   mnemonic/derivation ever changes. Addresses are re-derived from the
 *   private keys via viem's `privateKeyToAccount` so they are checksummed
 *   consistently with what `jsonRpcProvider()` produces (anvil's own
 *   config-out addresses are lowercase).
 * - `stop()` kills the child process (SIGTERM, then SIGKILL after a grace
 *   period) and removes the temporary config-out directory. Tests MUST call
 *   `stop()` in an `afterAll`/`afterEach` even when the test body throws.
 */

import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** The shape of the anvil child process: stdin ignored, stdout/stderr piped. */
type AnvilChildProcess = ChildProcessByStdio<null, Readable, Readable>;

/** Override the anvil binary path/name via `ANVIL_BIN` if it's not on PATH. */
const ANVIL_BIN = process.env["ANVIL_BIN"] ?? "anvil";

/** How long to poll for anvil to accept JSON-RPC requests before giving up. */
const READY_TIMEOUT_MS = 15_000;
/** Poll interval while waiting for anvil to become ready. */
const READY_POLL_INTERVAL_MS = 150;
/** Randomized port range — deliberately far from the default 8545. */
const MIN_PORT = 20_000;
const MAX_PORT = 40_000;
/** Retry a handful of times in case a randomly chosen port is already bound. */
const MAX_START_ATTEMPTS = 3;
/** Grace period before escalating from SIGTERM to SIGKILL on stop(). */
const STOP_GRACE_MS = 3_000;

export interface AnvilAccount {
  /** Checksummed address, derived from `privateKey` via viem. */
  readonly address: string;
  /** 0x-prefixed private key for this account (Anvil's deterministic dev keys). */
  readonly privateKey: string;
}

export interface AnvilInstance {
  /** HTTP JSON-RPC endpoint for the running instance, e.g. http://127.0.0.1:23456. */
  readonly rpcUrl: string;
  /** Chain id reported by the running instance (Anvil's default is 31337). */
  readonly chainId: number;
  /** Anvil's deterministic dev accounts, in order (accounts[0] is the default sender). */
  readonly accounts: AnvilAccount[];
  /** Stops the anvil child process and cleans up its temp config-out directory. */
  stop(): Promise<void>;
}

interface AnvilConfigOut {
  available_accounts: string[];
  private_keys: string[];
}

/**
 * Returns true iff the `anvil` binary can be executed on this machine.
 * Use this to `describe.skip`/`it.skip` e2e suites with a clear message when
 * anvil is not installed, rather than failing the whole run.
 */
export function isAnvilAvailable(): boolean {
  try {
    const result = spawnSync(ANVIL_BIN, ["--version"], { stdio: "ignore" });
    return result.error === undefined && result.status === 0;
  } catch {
    return false;
  }
}

function randomPort(): number {
  return MIN_PORT + Math.floor(Math.random() * (MAX_PORT - MIN_PORT));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `eth_chainId` until it succeeds or `timeoutMs` elapses. */
async function waitUntilReady(rpcUrl: string, timeoutMs: number): Promise<number> {
  const client = createPublicClient({ transport: http(rpcUrl) });
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const chainId = await client.getChainId();
      return chainId;
    } catch (err) {
      lastError = err;
      await sleep(READY_POLL_INTERVAL_MS);
    }
  }

  throw new Error(
    `anvil did not become ready at ${rpcUrl} within ${timeoutMs}ms. Last error: ${String(lastError)}`,
  );
}

/** Wait for the config-out JSON file to appear (anvil writes it once initialized). */
async function waitForConfigOut(path: string, timeoutMs: number): Promise<AnvilConfigOut> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, "utf-8")) as AnvilConfigOut;
      } catch {
        // File may still be mid-write; retry until timeout.
      }
    }
    await sleep(READY_POLL_INTERVAL_MS);
  }
  throw new Error(`anvil config-out file was not written at ${path} within ${timeoutMs}ms`);
}

function killAndWait(child: AnvilChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const onExit = (): void => resolve();
    child.once("exit", onExit);
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, STOP_GRACE_MS);
  });
}

/**
 * Spawns a fresh, isolated anvil instance on a randomized port.
 *
 * Retries with a new random port (up to MAX_START_ATTEMPTS times) if the
 * chosen port is already bound or anvil otherwise fails to become ready —
 * this keeps the harness robust in CI where multiple anvil instances may run
 * concurrently across worktrees/test files.
 */
export async function startAnvil(): Promise<AnvilInstance> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_START_ATTEMPTS; attempt++) {
    const port = randomPort();
    const rpcUrl = `http://127.0.0.1:${port}`;
    const configDir = mkdtempSync(join(tmpdir(), "redeploy-anvil-"));
    const configOutPath = join(configDir, "anvil-config.json");

    const child = spawn(
      ANVIL_BIN,
      ["--port", String(port), "--silent", "--config-out", configOutPath],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stderrBuf = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    let exitedEarly = false;
    child.once("exit", () => {
      exitedEarly = true;
    });

    try {
      const readyPromise = (async (): Promise<{ chainId: number; config: AnvilConfigOut }> => {
        const chainId = await waitUntilReady(rpcUrl, READY_TIMEOUT_MS);
        const config = await waitForConfigOut(configOutPath, READY_TIMEOUT_MS);
        return { chainId, config };
      })();

      const failFastPromise = new Promise<never>((_, reject) => {
        const check = setInterval(() => {
          if (exitedEarly) {
            clearInterval(check);
            reject(new Error(`anvil exited early on port ${port}. stderr: ${stderrBuf}`));
          }
        }, READY_POLL_INTERVAL_MS);
        // Ensure the interval never keeps the process alive indefinitely.
        check.unref?.();
      });

      const { chainId, config } = await Promise.race([readyPromise, failFastPromise]);

      const accounts: AnvilAccount[] = config.private_keys.map((privateKey) => ({
        address: privateKeyToAccount(privateKey as `0x${string}`).address,
        privateKey,
      }));

      let stopped = false;
      const stop = async (): Promise<void> => {
        if (stopped) return;
        stopped = true;
        await killAndWait(child);
        rmSync(configDir, { recursive: true, force: true });
      };

      return { rpcUrl, chainId, accounts, stop };
    } catch (err) {
      lastError = err;
      await killAndWait(child);
      rmSync(configDir, { recursive: true, force: true });
      // Retry with a new random port.
    }
  }

  throw new Error(
    `Failed to start anvil after ${MAX_START_ATTEMPTS} attempts. Last error: ${String(lastError)}`,
  );
}
