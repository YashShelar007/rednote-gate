import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enqueue, readItem } from "./queue.js";
import { readLedger } from "./ledger.js";
import { startApproval } from "./approval.js";

const TOKEN = "a".repeat(48);
type Res = { status: number; body: string; headers: Record<string, unknown> };

async function setup(extra: Partial<Parameters<typeof startApproval>[0]> = {}) {
  const root = mkdtempSync(join(tmpdir(), "rng-approval-"));
  const o = { dir: join(root, "queue"), ledger: join(root, "ledger.jsonl"), token: TOKEN, port: 0, limits: { daily: 5, commentGapMin: 10 }, dryRun: true, ...extra };
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

test("health needs the token and reports the mode", async () => {
  const s = await setup();
  assert.equal((await s.call("GET", "/health")).status, 403);
  const ok = await s.call("GET", `/health?t=${TOKEN}`);
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body), { ok: true, dryRun: true });
  s.close();
});

test("the read API answers only token-carrying non-browser callers", async () => {
  const s = await setup({ reads: { echo: async (a: unknown) => ({ got: a }) } });
  const json = { "content-type": "application/json" };
  const body = JSON.stringify({ tool: "echo", args: { x: 1 } });
  assert.equal((await s.call("POST", "/api/read", json, body)).status, 403, "no token");
  assert.equal((await s.call("POST", "/api/read", { ...json, "x-rednote-gate-token": TOKEN, origin: `http://127.0.0.1:${s.port}` }, body)).status, 403, "a browser page may not use it");
  const ok = await s.call("POST", "/api/read", { ...json, "x-rednote-gate-token": TOKEN }, body);
  assert.deepEqual(JSON.parse(ok.body), { ok: true, result: { got: { x: 1 } } });
  const unknown = await s.call("POST", "/api/read", { ...json, "x-rednote-gate-token": TOKEN }, JSON.stringify({ tool: "create_post", args: {} }));
  assert.equal(JSON.parse(unknown.body).ok, false, "only the read tools exist here");
  s.close();
});

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

test("a real browser's own POST is accepted (Chrome may send Origin: null with Sec-Fetch-Site: same-origin)", async () => {
  const s = await setup();
  const { item } = enqueue(s.dir, "post_comment", { noteUrl: "u", text: "hi" });
  const body = new URLSearchParams({ t: TOKEN, id: item.id, action: "approve" }).toString();
  const cross = await s.call("POST", "/decide", { origin: "null", "sec-fetch-site": "cross-site", "content-type": "application/x-www-form-urlencoded" }, body);
  assert.equal(cross.status, 403, "a null origin from another site is still refused");
  const own = await s.call("POST", "/decide", { origin: "null", "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" }, body);
  assert.equal(own.status, 303);
  assert.equal(readItem(s.dir, item.id).status, "approved");
  s.close();
});

test("the page keeps referrers same-origin, so browsers send a real Origin and the token never leaves the page", async () => {
  const s = await setup();
  assert.equal((await s.call("GET", `/?t=${TOKEN}`)).headers["referrer-policy"], "same-origin");
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

test("a queued video is served for preview, and only from the queue", async () => {
  const s = await setup();
  const src = join(mkdtempSync(join(tmpdir(), "rng-vid-")), "clip.mp4");
  writeFileSync(src, Buffer.concat([Buffer.from("0000001c667479706d703432", "hex"), Buffer.alloc(64)]));
  const { item } = enqueue(s.dir, "create_video", { title: "t", body: "b", video: src });
  const page = await s.call("GET", `/?t=${TOKEN}`);
  assert.match(page.body, /<video[^>]+src="\/media\//);
  assert.match(String(page.headers["content-security-policy"]), /media-src 'self'/);
  const ok = await s.call("GET", `/media/${item.id}?t=${TOKEN}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["content-type"], "video/mp4");
  assert.equal((await s.call("GET", `/media/..%2Fledger?t=${TOKEN}`)).status, 404);
  s.close();
});

const settingsForm = (s: Awaited<ReturnType<typeof setup>>, fields: Record<string, string>, origin = `http://127.0.0.1:${s.port}`) =>
  s.call("POST", "/settings", { origin, "content-type": "application/x-www-form-urlencoded" }, new URLSearchParams({ t: TOKEN, ...fields }).toString());
const base = { mode: "dry", daily: "5", likes: "10", commentGapMin: "10", notify: "on", openApproval: "on" };

test("the dashboard shows settings only when it has a settings file", async () => {
  const plain = await setup();
  assert.equal((await plain.call("GET", `/settings?t=${TOKEN}`)).status, 404);
  assert.doesNotMatch((await plain.call("GET", `/?t=${TOKEN}`)).body, /href="\/settings/);
  plain.close();
  const s = await setup({ settingsFile: join(mkdtempSync(join(tmpdir(), "rng-set-")), "settings.json") });
  const queue = (await s.call("GET", `/?t=${TOKEN}`)).body;
  assert.match(queue, /<meter/);
  assert.match(queue, /href="\/settings\?t=/);
  const settings = await s.call("GET", `/settings?t=${TOKEN}`);
  assert.match(settings.body, /name="daily"[^>]*max="20"/);
  assert.doesNotMatch(settings.body, /http-equiv=refresh/, "a form page never reloads under the user");
  s.close();
});

test("settings save from the dashboard, within the hard maximums", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "rng-set-")), "settings.json");
  const s = await setup({ settingsFile: file });
  const ok = await settingsForm(s, { ...base, daily: "8" });
  assert.equal(ok.status, 303);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).daily, 8);
  const tooMany = await settingsForm(s, { ...base, daily: "99" });
  assert.equal(tooMany.status, 303);
  assert.match(String(tooMany.headers.location), /error=/);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).daily, 8, "not saved");
  assert.equal((await settingsForm(s, { ...base, daily: "9" }, "https://evil.example")).status, 403);
  s.close();
});

test("going live from the dashboard needs the confirmation tick", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "rng-set-")), "settings.json");
  const s = await setup({ settingsFile: file });
  await settingsForm(s, { ...base, mode: "live" });
  assert.equal(existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).dryRun : undefined, undefined, "refused without the tick");
  await settingsForm(s, { ...base, mode: "live", confirmLive: "on" });
  assert.equal(JSON.parse(readFileSync(file, "utf8")).dryRun, false);
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
