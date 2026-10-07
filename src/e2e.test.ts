// End to end, the way users run it: an MCP client starts dist/index.js, which starts the detached
// service (dist/service.js). Everything lives in a fresh temp folder with no login. Nothing here
// approves an item or calls a tool that opens a browser, so RedNote is never contacted.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CATALOGUE } from "./help.js";

const ROOT = mkdtempSync(join(tmpdir(), "rng-e2e-"));
const DATA = join(ROOT, "data");
const CALL = { timeout: 40_000 }; // the first queued write starts the service, which may take up to 20 s

const client = new Client({ name: "rednote-gate-e2e", version: "0.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("./index.js", import.meta.url))],
  // The SDK passes only these plus a few safe basics (PATH, HOME), so the owner's own RN_* never leak in.
  env: { RN_DATA_DIR: DATA, RN_SESSION_PATH: join(ROOT, "session", "state.json"), RN_APPROVAL_PORT: "0", RN_OPEN_APPROVAL: "0", RN_NOTIFY: "0", RN_DRY_RUN: "1" },
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Stops the detached service by the pid in its lock file and waits until it is really gone. */
async function stopService() {
  const lock = join(DATA, "lock");
  if (!existsSync(lock)) return;
  const pid = Number(readFileSync(lock, "utf8"));
  if (!pid || !alive(pid)) return;
  process.kill(pid, "SIGTERM");
  for (const end = Date.now() + 10_000; Date.now() < end && alive(pid); ) await new Promise((r) => setTimeout(r, 100));
  if (alive(pid)) {
    process.kill(pid, "SIGKILL");
    throw new Error(`The service (pid ${pid}) ignored SIGTERM for 10 s and was killed.`);
  }
}

describe("rednote-gate over MCP, with the real background service", { timeout: 180_000 }, () => {
  before(() => client.connect(transport, CALL));

  after(async () => {
    try {
      await client.close();
    } finally {
      await stopService();
      rmSync(ROOT, { recursive: true, force: true });
    }
  });

  test("lists exactly the tools in the help catalogue", async () => {
    const { tools } = await client.listTools(undefined, CALL);
    assert.deepEqual(tools.map((t) => t.name).sort(), CATALOGUE.tools.map((t) => t.name).sort());
  });

  test("lists exactly the workflows in the help catalogue as prompts", async () => {
    const { prompts } = await client.listPrompts(undefined, CALL);
    assert.deepEqual(prompts.map((p) => p.name).sort(), CATALOGUE.workflows.map((w) => w.name).sort());
  });
});
