import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLedger, budgetCheck, haltReason, readLedger, type Entry } from "./ledger.js";

const LIMITS = { daily: 5, commentGapMin: 10 };
const file = () => join(mkdtempSync(join(tmpdir(), "rng-ledger-")), "ledger.jsonl");
const t0 = new Date("2026-10-06T12:00:00Z");
const mins = (m: number) => new Date(t0.getTime() + m * 60_000);
const attempt = (at: Date, tool: Entry["tool"] = "create_post", dryRun = false): Entry => ({ at: at.toISOString(), event: "attempt", id: "q_x", tool, dryRun });

test("ledger lines round-trip through the file", () => {
  const f = file();
  appendLedger(f, attempt(t0));
  appendLedger(f, { at: t0.toISOString(), event: "result", id: "q_x", outcome: "posted" });
  assert.deepEqual(readLedger(f).map((e) => e.event), ["attempt", "result"]);
});

test("a missing ledger reads as empty", () => {
  assert.deepEqual(readLedger(file()), []);
});

test("budget: the sixth live write in 24 hours waits until the oldest one ages out", () => {
  const entries = [0, 60, 120, 180, 240].map((m) => attempt(mins(m)));
  const check = budgetCheck(entries, "create_post", mins(300), LIMITS);
  assert.equal(check.ok, false);
  assert.deepEqual(!check.ok && check.retryAt, mins(24 * 60));
  assert.equal(budgetCheck(entries, "create_post", mins(24 * 60 + 1), LIMITS).ok, true);
});

test("budget: dry runs do not count", () => {
  const entries = [0, 1, 2, 3, 4, 5, 6].map((m) => attempt(mins(m), "create_post", true));
  assert.equal(budgetCheck(entries, "create_post", mins(10), LIMITS).ok, true);
});

test("budget: a comment or reply needs 10 minutes since the last live comment or reply", () => {
  const entries = [attempt(t0, "reply_comment")];
  const early = budgetCheck(entries, "post_comment", mins(9), LIMITS);
  assert.equal(early.ok, false);
  assert.deepEqual(!early.ok && early.retryAt, mins(10));
  assert.equal(budgetCheck(entries, "post_comment", mins(10), LIMITS).ok, true);
  assert.equal(budgetCheck(entries, "create_post", mins(1), LIMITS).ok, true, "posts are not held by the comment gap");
});

test("budget holds across a restart because it is read back from the file", () => {
  const f = file();
  for (const m of [0, 1, 2, 3, 4]) appendLedger(f, attempt(mins(m)));
  assert.equal(budgetCheck(readLedger(f), "create_post", mins(5), LIMITS).ok, false);
});

test("likes have their own daily cap and do not use the write budget", () => {
  const limits = { daily: 5, commentGapMin: 10, likes: 10 };
  const fivePosts = [0, 1, 2, 3, 4].map((m) => attempt(mins(m)));
  assert.equal(budgetCheck(fivePosts, "like_note", mins(5), limits).ok, true, "posts do not use up likes");
  const tenLikes = Array.from({ length: 10 }, (_, m) => attempt(mins(m), "like_note"));
  assert.equal(budgetCheck(tenLikes, "like_note", mins(10), limits).ok, false, "the 11th like waits");
  assert.equal(budgetCheck(tenLikes, "create_post", mins(10), limits).ok, true, "likes do not use up writes");
});

test("halt: a blocked line halts until a later resumed line", () => {
  const blocked: Entry = { at: t0.toISOString(), event: "blocked", detail: "captcha" };
  assert.equal(haltReason([]), null);
  assert.equal(haltReason([blocked]), "captcha");
  assert.equal(haltReason([blocked, { at: mins(1).toISOString(), event: "resumed" }]), null);
});
