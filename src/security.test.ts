// Security review checks for v1.1: the settings boundary and approvals bound to the mode the human saw.
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enqueue, readItem } from "./queue.js";
import { startApproval } from "./approval.js";
import { MAX, loadSettings, saveSettings } from "./settings.js";

const TOKEN = "b".repeat(48);

/** Like service.ts: mode and limits are getters on settings.json, so a change applies to the next request. */
async function liveSettingsServer() {
  const root = mkdtempSync(join(tmpdir(), "rng-sec-"));
  const file = join(root, "settings.json");
  const { server, port } = await startApproval({
    dir: join(root, "queue"),
    ledger: join(root, "ledger.jsonl"),
    token: TOKEN,
    port: 0,
    settingsFile: file,
    get limits() {
      const s = loadSettings(file, {});
      return { daily: s.daily, likes: s.likes, commentGapMin: s.commentGapMin };
    },
    get dryRun() {
      return loadSettings(file, {}).dryRun;
    },
  });
  const call = (method: string, path: string, headers: Record<string, string> = {}, body = ""): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode!, body: data }));
      });
      req.on("error", reject);
      req.end(body);
    });
  const post = (path: string, fields: Record<string, string>) =>
    call("POST", path, { origin: `http://127.0.0.1:${port}`, "content-type": "application/x-www-form-urlencoded" }, new URLSearchParams(fields).toString());
  return { dir: join(root, "queue"), file, call, post, close: () => server.close() };
}

/** Exactly what the browser sends when the human clicks Approve on this rendered page. */
function approveClick(html: string): Record<string, string> {
  const form = [...html.matchAll(/<form method=post action="\/decide">(.*?)<\/form>/gs)].map((m) => m[1]).find((f) => f.includes('value="approve"'));
  assert.ok(form, "the page has an Approve button");
  const hidden = [...form.matchAll(/<input type=hidden name=(\w+) value="([^"]*)">/g)].map((m) => [m[1], m[2]]);
  return { ...Object.fromEntries(hidden), action: "approve" };
}

test("an Approve click on a page that showed dry run never becomes a live approval after the mode changes", async (t) => {
  const s = await liveSettingsServer();
  t.after(s.close);
  const { item } = enqueue(s.dir, "post_comment", { noteUrl: "u", text: "hi" });
  const page = (await s.call("GET", `/?t=${TOKEN}`)).body;
  assert.match(page, /Approve dry run/);

  saveSettings(s.file, { dryRun: false }, {}); // switched to live in another tab, or by editing settings.json
  const res = await s.post("/decide", approveClick(page));

  assert.equal(res.status, 409);
  assert.equal(readItem(s.dir, item.id).status, "pending", "not approved for a mode the human never saw");
});

test("an Approve click is bound to the mode its page showed", async (t) => {
  const s = await liveSettingsServer();
  t.after(s.close);
  const { item } = enqueue(s.dir, "post_comment", { noteUrl: "u", text: "hi" });
  const page = (await s.call("GET", `/?t=${TOKEN}`)).body;

  assert.equal((await s.post("/decide", approveClick(page))).status, 303);
  assert.equal(readItem(s.dir, item.id).approvedFor, "dry_run");
});

test("a crafted settings.json cannot pass the hard maximums or switch to live with a non-boolean", () => {
  const file = join(mkdtempSync(join(tmpdir(), "rng-sec-")), "settings.json");
  writeFileSync(file, '{"daily": 1e400, "likes": "999", "commentGapMin": -5, "dryRun": "false", "__proto__": {"dryRun": false}}');
  const s = loadSettings(file, {});
  assert.deepEqual([s.daily, s.likes, s.commentGapMin, s.dryRun], [MAX.daily, MAX.likes, MAX.minCommentGapMin, true]);
});

test("the settings page needs the token and shows a crafted error message as text", async (t) => {
  const s = await liveSettingsServer();
  t.after(s.close);
  assert.equal((await s.call("GET", "/settings")).status, 403);
  assert.equal((await s.call("GET", `/settings?t=${TOKEN}`, { host: "evil.example" })).status, 403);
  const res = await s.call("GET", `/settings?t=${TOKEN}&error=${encodeURIComponent('<img src=x onerror="alert(1)">')}`);
  assert.equal(res.status, 200);
  assert.match(res.body, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(res.body, /<img src=x/);
});
