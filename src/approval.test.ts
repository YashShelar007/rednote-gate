import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enqueue, readItem } from "./queue.js";
import { readLedger } from "./ledger.js";
import { startApproval } from "./approval.js";

const TOKEN = "a".repeat(48);
type Res = { status: number; body: string; headers: Record<string, unknown> };

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "rng-approval-"));
  const o = { dir: join(root, "queue"), ledger: join(root, "ledger.jsonl"), token: TOKEN, port: 0, limits: { daily: 5, commentGapMin: 10 }, dryRun: true };
  const { server, port } = await startApproval(o);
  const call = (method: string, path: string, headers: Record<string, string> = {}, body = ""): Promise<Res> =>
    new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode!, body: data, headers: res.headers }));
      });
      req.on("error", reject);
      req.end(body);
    });
  const form = (fields: Record<string, string>, origin = `http://127.0.0.1:${port}`) =>
    call("POST", "/decide", { origin, "content-type": "application/x-www-form-urlencoded" }, new URLSearchParams(fields).toString());
  return { ...o, port, call, form, close: () => server.close() };
}

test("the page refuses requests without the token", async () => {
  const s = await setup();
  assert.equal((await s.call("GET", "/")).status, 403);
  s.close();
});

test("the page refuses a foreign Host header (DNS rebinding)", async () => {
  const s = await setup();
  assert.equal((await s.call("GET", `/?t=${TOKEN}`, { host: "evil.example:80" })).status, 403);
  s.close();
});

test("queued text is shown escaped, never as live HTML", async () => {
  const s = await setup();
  enqueue(s.dir, "post_comment", { noteUrl: "https://www.xiaohongshu.com/explore/a?xsec_token=b", text: "<script>alert(1)</script>" });
  const res = await s.call("GET", `/?t=${TOKEN}`);
  assert.equal(res.status, 200);
  assert.match(res.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(res.body, /<script>alert/);
  assert.match(String(res.headers["content-security-policy"]), /default-src 'none'/);
  assert.equal(res.headers["x-frame-options"], "DENY");
  s.close();
});

test("a POST from another website cannot approve", async () => {
  const s = await setup();
  const { item } = enqueue(s.dir, "post_comment", { noteUrl: "u", text: "hi" });
  assert.equal((await s.form({ t: TOKEN, id: item.id, action: "approve" }, "https://evil.example")).status, 403);
  assert.equal((await s.call("POST", "/decide", { "content-type": "application/x-www-form-urlencoded" }, `t=${TOKEN}&id=${item.id}&action=approve`)).status, 403, "no Origin header");
  assert.equal(readItem(s.dir, item.id).status, "pending");
  s.close();
});

test("Approve only marks the item; nothing is posted", async () => {
  const s = await setup();
  const { item } = enqueue(s.dir, "post_comment", { noteUrl: "u", text: "hi" });
  const res = await s.form({ t: TOKEN, id: item.id, action: "approve" });
  assert.equal(res.status, 303);
  assert.equal(readItem(s.dir, item.id).status, "approved");
  assert.deepEqual(readLedger(s.ledger), []);
  s.close();
});

test("Reject and Cancel both end at rejected", async () => {
  const s = await setup();
  const a = enqueue(s.dir, "post_comment", { noteUrl: "u", text: "a" }).item;
  const b = enqueue(s.dir, "post_comment", { noteUrl: "u", text: "b" }).item;
  await s.form({ t: TOKEN, id: a.id, action: "reject" });
  await s.form({ t: TOKEN, id: b.id, action: "approve" });
  await s.form({ t: TOKEN, id: b.id, action: "cancel" });
  assert.equal(readItem(s.dir, a.id).status, "rejected");
  assert.equal(readItem(s.dir, b.id).status, "rejected");
  s.close();
});

test("images are served only from the queue, by item id and index", async () => {
  const s = await setup();
  const src = join(mkdtempSync(join(tmpdir(), "rng-img-")), "a.png");
  writeFileSync(src, Buffer.from("89504e470d0a1a0a0000", "hex"));
  const { item } = enqueue(s.dir, "create_post", { title: "t", body: "b", images: [src] });
  const ok = await s.call("GET", `/img/${item.id}/0?t=${TOKEN}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["content-type"], "image/png");
  assert.equal((await s.call("GET", `/img/${item.id}/1?t=${TOKEN}`)).status, 404);
  assert.equal((await s.call("GET", `/img/..%2F..%2Fledger/0?t=${TOKEN}`)).status, 404);
  s.close();
});

test("Resume clears a captcha halt", async () => {
  const s = await setup();
  writeFileSync(s.ledger, JSON.stringify({ at: new Date().toISOString(), event: "blocked", detail: "captcha" }) + "\n");
  const res = await s.call("POST", "/resume", { origin: `http://127.0.0.1:${s.port}`, "content-type": "application/x-www-form-urlencoded" }, `t=${TOKEN}`);
  assert.equal(res.status, 303);
  assert.equal(readLedger(s.ledger).at(-1)?.event, "resumed");
  s.close();
});
