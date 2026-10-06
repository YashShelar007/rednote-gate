import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enqueue, readItem, transition } from "./queue.js";
import { BlockedError, NotSentError, appendLedger, readLedger } from "./ledger.js";
import { tick, type Runner } from "./worker.js";

const LIMITS = { daily: 5, commentGapMin: 10 };
function setup() {
  const root = mkdtempSync(join(tmpdir(), "rng-worker-"));
  return { dir: join(root, "queue"), ledger: join(root, "ledger.jsonl"), shots: join(root, "shots"), limits: LIMITS };
}
let clock = Date.parse("2026-01-01T00:00:00Z");
const approved = (dir: string, text: string, tool: "post_comment" | "create_post" = "post_comment", mode: "dry_run" | "live" = "live") => {
  const { item } = enqueue(dir, tool, { noteUrl: "u", text }, new Date((clock += 1000)));
  transition(dir, item.id, "approved", undefined, new Date(), { approvedFor: mode });
  return item.id;
};
const counting = () => {
  const calls: string[] = [];
  const run: Runner = async (item) => {
    calls.push(item.id);
  };
  return Object.assign(run, { calls });
};

test("only approved items run; pending ones wait for a human", async () => {
  const o = setup();
  enqueue(o.dir, "post_comment", { noteUrl: "u", text: "not approved" });
  const run = counting();
  assert.equal(await tick({ ...o, run, dryRun: false }), null);
  assert.deepEqual(run.calls, []);
});

test("a posted item is never posted again", async () => {
  const o = setup();
  const id = approved(o.dir, "hello");
  const run = counting();
  assert.equal(await tick({ ...o, run, dryRun: false }), "posted");
  assert.equal(await tick({ ...o, run, dryRun: false, now: new Date(Date.now() + 3600_000) }), null);
  assert.deepEqual(run.calls, [id]);
  assert.equal(readItem(o.dir, id).status, "posted");
});

test("the attempt is in the ledger before the browser starts", async () => {
  const o = setup();
  approved(o.dir, "hello");
  let seen = 0;
  await tick({ ...o, dryRun: false, run: async () => void (seen = readLedger(o.ledger).length) });
  assert.equal(seen, 1);
});

test("a live attempt that errors becomes unknown and is not retried", async () => {
  const o = setup();
  const id = approved(o.dir, "hello");
  assert.equal(await tick({ ...o, dryRun: false, run: async () => { throw new Error("timeout after click"); } }), "unknown");
  const run = counting();
  await tick({ ...o, run, dryRun: false, now: new Date(Date.now() + 3600_000) });
  assert.deepEqual(run.calls, []);
  assert.equal(readItem(o.dir, id).status, "unknown");
});

test("dry run marks the item dry_run, writes a screenshot path, and spends no budget", async () => {
  const o = setup();
  const id = approved(o.dir, "hello", "post_comment", "dry_run");
  assert.equal(await tick({ ...o, run: counting(), dryRun: true }), "dry_run");
  const result = readLedger(o.ledger).find((e) => e.event === "result");
  assert.equal(result?.screenshot, join(o.shots, `${id}.png`));
  assert.equal(readLedger(o.ledger).filter((e) => e.event === "attempt" && e.dryRun === false).length, 0);
});

test("one item per tick, oldest first", async () => {
  const o = setup();
  const first = approved(o.dir, "one", "post_comment", "dry_run");
  approved(o.dir, "two", "post_comment", "dry_run");
  const run = counting();
  await tick({ ...o, run, dryRun: true });
  assert.deepEqual(run.calls, [first]);
});

test("an approved item over budget waits", async () => {
  const o = setup();
  const now = new Date();
  for (let i = 0; i < 5; i++) appendLedger(o.ledger, { at: now.toISOString(), event: "attempt", tool: "create_post", dryRun: false });
  const id = approved(o.dir, "late");
  const run = counting();
  assert.equal(await tick({ ...o, run, dryRun: false, now }), null);
  assert.equal(readItem(o.dir, id).status, "approved");
});

test("a live error before the final click is failed, and the write can be queued again", async () => {
  const o = setup();
  const id = approved(o.dir, "hello");
  const outcome = await tick({ ...o, dryRun: false, run: async () => { throw new NotSentError("comment text changed"); } });
  assert.equal(outcome, "failed");
  assert.equal(enqueue(o.dir, "post_comment", { noteUrl: "u", text: "hello" }).duplicate, false);
  assert.equal(readItem(o.dir, id).history.at(-1)?.note, "comment text changed");
});

test("a fresh approval waits out the undo window before it runs", async () => {
  const o = setup();
  const id = approved(o.dir, "hello", "post_comment", "dry_run");
  const approvedAt = new Date(readItem(o.dir, id).history.at(-1)!.at).getTime();
  const run = counting();
  assert.equal(await tick({ ...o, run, dryRun: true, graceMs: 30_000, now: new Date(approvedAt + 29_000) }), null);
  assert.equal(await tick({ ...o, run, dryRun: true, graceMs: 30_000, now: new Date(approvedAt + 30_000) }), "dry_run");
  assert.deepEqual(run.calls, [id]);
});

test("an approval only runs in the mode it was given", async () => {
  const o = setup();
  approved(o.dir, "approved live", "post_comment", "live");
  approved(o.dir, "approved dry", "post_comment", "dry_run");
  const run = counting();
  assert.equal(await tick({ ...o, run, dryRun: true }), "dry_run");
  assert.equal(await tick({ ...o, run, dryRun: true }), null, "the live approval waits; it is not turned into a dry run");
  assert.equal(run.calls.length, 1);
});

test("no write starts while a read holds the browser", async () => {
  const o = setup();
  approved(o.dir, "hello");
  const run = counting();
  assert.equal(await tick({ ...o, run, dryRun: false, idle: () => false }), null);
  assert.deepEqual(run.calls, []);
  assert.equal(await tick({ ...o, run, dryRun: false, idle: () => true }), "posted");
});

test("a captcha halts the worker until a human resumes", async () => {
  const o = setup();
  approved(o.dir, "one");
  const second = approved(o.dir, "two");
  await tick({ ...o, dryRun: false, run: async () => { throw new BlockedError("slider captcha"); } });
  const run = counting();
  assert.equal(await tick({ ...o, run, dryRun: false, now: new Date(Date.now() + 3600_000) }), "halted");
  assert.deepEqual(run.calls, []);
  appendLedger(o.ledger, { at: new Date().toISOString(), event: "resumed" });
  await tick({ ...o, run, dryRun: false, now: new Date(Date.now() + 3600_000) });
  assert.deepEqual(run.calls, [second]);
});
