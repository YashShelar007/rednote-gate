// The ledger: an append-only data/ledger.jsonl with one line per event. The daily budget and the
// halt state are both derived from it, so they survive a restart without any extra state.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { Status, Tool } from "./queue.js";

export interface Entry {
  at: string;
  event: "attempt" | "result" | "blocked" | "resumed";
  id?: string;
  tool?: Tool;
  dryRun?: boolean;
  outcome?: Status;
  detail?: string;
  screenshot?: string;
}

export interface Limits {
  daily: number; // live attempts per rolling 24 hours
  commentGapMin: number; // minutes between live comments or replies
}

/** RedNote showed a captcha or a "too frequent" warning. Stop; never retry. */
export class BlockedError extends Error {}

const DAY_MS = 24 * 3600_000;
const COMMENT_TOOLS: Tool[] = ["post_comment", "reply_comment"];

export function appendLedger(file: string, entry: Entry): void {
  appendFileSync(file, JSON.stringify(entry) + "\n");
}

/** Throws on a corrupt line on purpose: a budget we cannot read must fail closed. */
export function readLedger(file: string): Entry[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line, n) => {
      try {
        return JSON.parse(line) as Entry;
      } catch {
        throw new Error(`${file} line ${n + 1} is not valid JSON. Fix or remove it before writes can continue.`);
      }
    });
}

export type BudgetCheck = { ok: true } | { ok: false; reason: string; retryAt: Date };

/** Failed and unknown live attempts count too: a click that errored may still have posted. */
export function budgetCheck(entries: Entry[], tool: Tool, now: Date, limits: Limits): BudgetCheck {
  const live = entries.filter((e) => e.event === "attempt" && e.dryRun === false).map((e) => ({ tool: e.tool, at: new Date(e.at).getTime() }));
  const lastDay = live.filter((e) => e.at > now.getTime() - DAY_MS);
  if (lastDay.length >= limits.daily) {
    const retryAt = new Date(Math.min(...lastDay.map((e) => e.at)) + DAY_MS);
    return { ok: false, reason: `daily limit of ${limits.daily} live writes reached`, retryAt };
  }
  if (COMMENT_TOOLS.includes(tool)) {
    const comments = live.filter((e) => e.tool && COMMENT_TOOLS.includes(e.tool));
    const last = comments.length ? Math.max(...comments.map((e) => e.at)) : -Infinity;
    const retryAt = new Date(last + limits.commentGapMin * 60_000);
    if (retryAt > now) return { ok: false, reason: `one comment every ${limits.commentGapMin} minutes`, retryAt };
  }
  return { ok: true };
}

/** The detail of the latest "blocked" line if no "resumed" line came after it, else null. */
export function haltReason(entries: Entry[]): string | null {
  const last = entries.filter((e) => e.event === "blocked" || e.event === "resumed").at(-1);
  return last?.event === "blocked" ? last.detail || "blocked" : null;
}
