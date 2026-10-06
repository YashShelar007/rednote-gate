// Independent review tests. Tests marked "fixed:" reproduced bugs the review found and now guard against them; the rest pin down
// invariants that had no direct test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enqueue, readItem, transition } from "./queue.js";
import { BlockedError, NotSentError, appendLedger, budgetCheck, type Entry, type Limits } from "./ledger.js";
import { tick, type Runner } from "./worker.js";
import { startApproval } from "./approval.js";
import { runWrite } from "./rednote.js";

const TOKEN = "b".repeat(48);
const LIMITS: Limits = { daily: 5, commentGapMin: 10 };
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const NOTE = "https://www.xiaohongshu.com/explore/6aa4b5e80000000028037e0b";
const t0 = new Date("2026-10-06T12:00:00Z");
const liveAttempt = (at: Date | string, tool: Entry["tool"] = "create_post"): Entry => ({ at: typeof at === "string" ? at : at.toISOString(), event: "attempt", tool, dryRun: false });

const counting = () => {
  const calls: string[] = [];
  const run: Runner = async (item) => void calls.push(item.id);
  return Object.assign(run, { calls });
};

async function approvalPage(dryRun: boolean, limits = LIMITS) {
  const root = mkdtempSync(join(tmpdir(), "rng-review-"));
  const o = { dir: join(root, "queue"), ledger: join(root, "ledger.jsonl"), shots: join(root, "shots"), token: TOKEN, port: 0, limits, dryRun };
  const { server, port } = await startApproval(o);
  const call = (method: string, path: string, body = ""): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const headers = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "content-type": "application/x-www-form-urlencoded" };
      const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode!, body: data }));
      });
      req.on("error", reject);
      req.end(body);
    });
  const decide = (id: string, action: string) => call("POST", "/decide", new URLSearchParams({ t: TOKEN, id, action }).toString());
  return { ...o, call, decide, close: () => server.close() };
}

// ─── BUG: fail on the current code ─────────────────────────────────────────────────────────

test("fixed: an item approved on the dry-run page never posts live after a restart with RN_DRY_RUN=0", async () => {
  const s = await approvalPage(true); // the human clicks "Approve dry run": "never published or sent"
  const { item } = enqueue(s.dir, "post_comment", { noteUrl: `${NOTE}?xsec_token=x`, text: "hello" });
  assert.equal((await s.decide(item.id, "approve")).status, 303);
  s.close();
  // Owner restarts in live mode before the dry run ran (halted, inside the undo window, or crashed).
  const run = counting();
  await tick({ dir: s.dir, ledger: s.ledger, shots: s.shots, limits: LIMITS, dryRun: false, run, graceMs: 0 });
  assert.deepEqual(run.calls, [], "a dry-run approval must not authorise a live post");
  assert.notEqual(readItem(s.dir, item.id).status, "posted");
});

test("fixed: budget: a daily limit or comment gap that is not a number fails closed", () => {
  // index.ts: Number(process.env.RN_DAILY_WRITES || 5); a typo such as RN_DAILY_WRITES=five gives NaN.
  const five = [0, 1, 2, 3, 4].map((m) => liveAttempt(new Date(t0.getTime() + m * 60_000)));
  assert.equal(budgetCheck(five, "create_post", new Date(t0.getTime() + 5 * 60_000), { daily: NaN, commentGapMin: 10 }).ok, false, "daily NaN");
  const oneComment = [liveAttempt(t0, "post_comment")];
  assert.equal(budgetCheck(oneComment, "post_comment", new Date(t0.getTime() + 60_000), { daily: 5, commentGapMin: NaN }).ok, false, "gap NaN");
});

test("fixed: budget: an attempt line whose time cannot be read still counts", () => {
  // readLedger fails closed on bad JSON, but a well-formed line with a bad "at" silently drops out.
  const entries = [0, 1, 2, 3, 4].map(() => liveAttempt("not a date"));
  assert.equal(budgetCheck(entries, "create_post", t0, LIMITS).ok, false);
});

test("fixed: the approval page still renders when RN_DAILY_WRITES=0 and an item is approved", async () => {
  const s = await approvalPage(false, { daily: 0, commentGapMin: 10 });
  const { item } = enqueue(s.dir, "post_comment", { noteUrl: `${NOTE}?xsec_token=x`, text: "hi" });
  await s.decide(item.id, "approve");
  const res = await s.call("GET", `/?t=${TOKEN}`); // retryAt is new Date(Infinity); Intl.format throws
  s.close();
  assert.equal(res.status, 200, "the human must still be able to see and cancel approved items");
});

test("fixed: the same comment on the same note is a duplicate even with a fresh xsec_token", () => {
  const dir = mkdtempSync(join(tmpdir(), "rng-review-"));
  const first = enqueue(dir, "post_comment", { noteUrl: `${NOTE}?xsec_token=AAA&xsec_source=pc_search`, text: "nice" });
  const second = enqueue(dir, "post_comment", { noteUrl: `${NOTE}?xsec_token=BBB&xsec_source=pc_search`, text: "nice" });
  assert.equal(second.duplicate, true);
  assert.equal(second.item.id, first.item.id);
});

// ─── Coverage: pass today, guard the invariants ────────────────────────────────────────────

test("a Cancel that lands before the worker claims the item wins", async () => {
  const s = await approvalPage(false);
  const { item } = enqueue(s.dir, "post_comment", { noteUrl: `${NOTE}?xsec_token=x`, text: "hi" });
  await s.decide(item.id, "approve");
  assert.equal((await s.decide(item.id, "cancel")).status, 303);
  s.close();
  const run = counting();
  assert.equal(await tick({ dir: s.dir, ledger: s.ledger, shots: s.shots, limits: LIMITS, dryRun: false, run, graceMs: 0 }), null);
  assert.deepEqual(run.calls, []);
});

test("Cancel is refused once the worker has started the item", async () => {
  const s = await approvalPage(false);
  const { item } = enqueue(s.dir, "post_comment", { noteUrl: `${NOTE}?xsec_token=x`, text: "hi" });
  await s.decide(item.id, "approve");
  transition(s.dir, item.id, "posting", "live");
  assert.equal((await s.decide(item.id, "cancel")).status, 409);
  s.close();
  assert.equal(readItem(s.dir, item.id).status, "posting");
});

test("budget: an attempt exactly 24 hours old no longer counts, one millisecond earlier it does", () => {
  const entries = [0, 0, 0, 0, 0].map(() => liveAttempt(t0));
  const day = 24 * 3600_000;
  assert.equal(budgetCheck(entries, "create_post", new Date(t0.getTime() + day - 1), LIMITS).ok, false);
  assert.equal(budgetCheck(entries, "create_post", new Date(t0.getTime() + day), LIMITS).ok, true);
});

test("a write approved while halted does not run until a human resumes", async () => {
  const root = mkdtempSync(join(tmpdir(), "rng-review-"));
  const o = { dir: join(root, "queue"), ledger: join(root, "ledger.jsonl"), shots: join(root, "shots"), limits: LIMITS };
  appendLedger(o.ledger, { at: t0.toISOString(), event: "blocked", detail: "captcha" });
  const { item } = enqueue(o.dir, "post_comment", { noteUrl: `${NOTE}?xsec_token=x`, text: "hi" });
  transition(o.dir, item.id, "approved", undefined, new Date(), { approvedFor: "live" });
  const run = counting();
  assert.equal(await tick({ ...o, run, dryRun: false }), "halted");
  assert.deepEqual(run.calls, []);
});

test("a block found before the final click (NotSentError wrapping BlockedError) still halts", async () => {
  const root = mkdtempSync(join(tmpdir(), "rng-review-"));
  const o = { dir: join(root, "queue"), ledger: join(root, "ledger.jsonl"), shots: join(root, "shots"), limits: LIMITS };
  for (const text of ["one", "two"]) transition(o.dir, enqueue(o.dir, "post_comment", { noteUrl: `${NOTE}?xsec_token=x`, text }).item.id, "approved", undefined, new Date(), { approvedFor: "live" });
  const blocked: Runner = async () => {
    throw new NotSentError("captcha", { cause: new BlockedError("captcha") });
  };
  assert.equal(await tick({ ...o, run: blocked, dryRun: false }), "failed");
  const run = counting();
  assert.equal(await tick({ ...o, run, dryRun: false }), "halted");
  assert.deepEqual(run.calls, []);
});

test("a corrupt ledger line stops the worker instead of skipping the budget", async () => {
  const root = mkdtempSync(join(tmpdir(), "rng-review-"));
  const o = { dir: join(root, "queue"), ledger: join(root, "ledger.jsonl"), shots: join(root, "shots"), limits: LIMITS };
  transition(o.dir, enqueue(o.dir, "post_comment", { noteUrl: `${NOTE}?xsec_token=x`, text: "hi" }).item.id, "approved", undefined, new Date(), { approvedFor: "live" });
  writeFileSync(o.ledger, '{"at":"2026-10-06T12:00:00Z","event":"attempt","dryRun":false\n'); // cut off by a crash
  const run = counting();
  await assert.rejects(tick({ ...o, run, dryRun: false }), /not valid JSON/);
  assert.deepEqual(run.calls, []);
});

test("a queued image changed after approval is refused as not sent, before the browser opens", async () => {
  const src = join(mkdtempSync(join(tmpdir(), "rng-review-")), "a.png");
  writeFileSync(src, PNG);
  const dir = mkdtempSync(join(tmpdir(), "rng-review-"));
  const { item } = enqueue(dir, "create_post", { title: "t", body: "b", images: [src] });
  writeFileSync(join(dir, (item.args as { images: string[] }).images[0]), Buffer.concat([PNG, Buffer.from("swapped")]));
  await assert.rejects(runWrite(item, dir, join(dir, "shot.png"), false), (e) => e instanceof NotSentError && /changed after it was queued/.test(e.message));
});
