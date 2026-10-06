// The worker: takes the oldest approved item that fits the budget, one at a time. The order of
// writes is what makes "never posted twice" hold:
//   1. ledger "attempt" line   2. item -> posting   3. browser   4. item -> outcome   5. ledger "result"
// A crash after step 2 leaves the item in "posting", which recoverInterrupted() turns into "unknown".
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { listItems, transition, type Item, type Status } from "./queue.js";
import { BlockedError, appendLedger, budgetCheck, haltReason, readLedger, type Limits } from "./ledger.js";

/** Runs one item in the browser. Must throw if anything went wrong. */
export type Runner = (item: Item, screenshot: string, dryRun: boolean) => Promise<void>;

export interface WorkerOptions {
  dir: string; // queue folder
  ledger: string; // ledger.jsonl path
  shots: string; // screenshots folder
  limits: Limits;
  dryRun: boolean;
  run: Runner;
  now?: Date;
}

/** Processes at most one item. Returns its outcome, "halted", or null when nothing was ready. */
export async function tick(o: WorkerOptions): Promise<Status | "halted" | null> {
  const now = o.now ?? new Date();
  const entries = readLedger(o.ledger);
  if (haltReason(entries)) return "halted";
  // Dry runs spend no budget, so only live mode has to fit inside it.
  const item = listItems(o.dir).find((i) => i.status === "approved" && (o.dryRun || budgetCheck(entries, i.tool, now, o.limits).ok));
  if (!item) return null;

  mkdirSync(o.shots, { recursive: true });
  const screenshot = join(o.shots, `${item.id}.png`);
  appendLedger(o.ledger, { at: now.toISOString(), event: "attempt", id: item.id, tool: item.tool, dryRun: o.dryRun });
  transition(o.dir, item.id, "posting");

  let outcome: Status = o.dryRun ? "dry_run" : "posted";
  let detail: string | undefined;
  try {
    await o.run(item, screenshot, o.dryRun);
  } catch (e) {
    // Live errors are "unknown", never "failed": the final click may have landed before the error.
    outcome = o.dryRun ? "failed" : "unknown";
    detail = e instanceof Error ? e.message : String(e);
    if (e instanceof BlockedError) appendLedger(o.ledger, { at: new Date().toISOString(), event: "blocked", id: item.id, detail });
  }
  transition(o.dir, item.id, outcome, detail);
  appendLedger(o.ledger, { at: new Date().toISOString(), event: "result", id: item.id, tool: item.tool, dryRun: o.dryRun, outcome, ...(detail && { detail }), screenshot });
  return outcome;
}

/** Polls every intervalMs. Never overlaps two ticks. */
export function startWorker(o: Omit<WorkerOptions, "now">, intervalMs = 10_000): () => void {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const outcome = await tick(o);
      if (outcome && outcome !== "halted") console.error(`[rednote-gate] worker: ${outcome}`);
    } catch (e) {
      console.error("[rednote-gate] worker error:", e instanceof Error ? e.message : e);
    } finally {
      busy = false;
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
