// End to end, the way users run it: an MCP client starts dist/index.js, which starts the detached
// service (dist/service.js). Everything lives in a fresh temp folder with no login. Nothing here
// approves an item or calls a tool that opens a browser, so RedNote is never contacted.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const NOTE = "https://www.xiaohongshu.com/explore/6a1111111111111111111111?xsec_token=x";
const COMMENT = `Great tips <script>alert("x")</script> & thanks`;

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args }, undefined, CALL);
  return { text: (r.content as Array<{ text: string }>)[0].text, isError: r.isError === true };
}
/** The approval link the service wrote. Only this test's temp copy, never the owner's. */
const approvalUrl = () => new URL(readFileSync(join(DATA, "approval-url"), "utf8").trim());
const get = (path: string) => fetch(new URL(path, approvalUrl()), { signal: AbortSignal.timeout(5_000) });

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

  test("rednote_help names the mode and every tool", async () => {
    const { text, isError } = await call("rednote_help");
    assert.equal(isError, false);
    assert.match(text, /Mode: DRY RUN/);
    for (const t of CATALOGUE.tools) assert.ok(text.includes(t.name), `help is missing ${t.name}`);
  });

  let queuedId = "";
  test("a comment is queued once, and queuing starts the background service", async () => {
    const first = await call("rednote_post_comment", { url: NOTE, text: COMMENT });
    assert.equal(first.isError, false, first.text);
    queuedId = first.text.match(/^Queued as (q_\d{8}T\d{6}_[0-9a-f]{4})\./)?.[1] ?? "";
    assert.ok(queuedId, first.text);
    assert.match(first.text, /Mode: dry run/);

    const again = await call("rednote_post_comment", { url: NOTE, text: COMMENT });
    assert.match(again.text, new RegExp(`^Already queued as ${queuedId} \\(status: pending\\)\\. Not queued again\\.`));

    const pid = Number(readFileSync(join(DATA, "lock"), "utf8"));
    assert.ok(alive(pid), "the service in the lock file is running");
    assert.notEqual(pid, transport.pid, "the service is its own process, not the MCP server");
    assert.equal((await get("/health")).status, 403, "health needs the token");
    const health = await get(`/health?t=${approvalUrl().searchParams.get("t")}`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, dryRun: true });
  });

  test("the service's approval page shows the queued comment, escaped", async () => {
    const res = await get(approvalUrl().pathname + approvalUrl().search);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes(queuedId), "the page lists the queued item");
    assert.ok(html.includes("Great tips &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; thanks"), "the exact text, escaped");
    assert.doesNotMatch(html, /<script>alert/);
  });

  // Everything else in each call is valid, so the named field is the only reason for the refusal.
  const png = join(ROOT, "a.png");
  writeFileSync(png, Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
  const refused: Array<[name: string, tool: string, args: Record<string, unknown>, why: RegExp]> = [
    ["a bare note url without xsec_token", "rednote_post_comment", { url: NOTE.split("?")[0], text: "hi" }, /Use a note url returned by rednote_search/],
    ["a title longer than RedNote's 20", "rednote_create_post", { title: "a".repeat(41), body: "fine", images: [png] }, /longer than RedNote's 20/],
    ["a # in a post body", "rednote_create_post", { title: "ok", body: "see #topic", images: [png] }, /Put hashtags in topics/],
    ["a relative image path", "rednote_create_post", { title: "ok", body: "fine", images: ["pics/a.png"] }, /Image path must be absolute/],
  ];
  for (const [name, tool, args, why] of refused) {
    test(`refuses ${name}`, async () => {
      const r = await call(tool, args);
      assert.equal(r.isError, true, r.text);
      assert.match(r.text, why);
    });
  }

  test("rednote_queue_status lists the comment as pending, and nothing refused was queued", async () => {
    const items = JSON.parse((await call("rednote_queue_status")).text) as Array<{ id: string; tool: string; status: string }>;
    assert.deepEqual(items.map(({ id, tool, status }) => ({ id, tool, status })), [{ id: queuedId, tool: "post_comment", status: "pending" }]);
  });
});
