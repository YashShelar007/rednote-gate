// The worker: takes the oldest approved item that fits the budget, one at a time. The order of
// writes is what makes "never posted twice" hold:
//   1. ledger "attempt" line   2. item -> posting   3. browser   4. item -> outcome   5. ledger "result"
// A crash after step 2 leaves the item in "posting", which recoverInterrupted() turns into "unknown".
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { listItems, transition, type Item, type Status } from "./queue.js";
import { BlockedError, NotSentError, appendLedger, budgetCheck, haltReason, readLedger, type Limits } from "./ledger.js";

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
  graceMs?: number; // undo window: an approval only runs once it is this old
  idle?: () => boolean; // false while a read holds the browser: writes start only on an idle browser
}

/** Processes at most one item. Returns its outcome, "halted", or null when nothing was ready. */
export async function tick(o: WorkerOptions): Promise<Status | "halted" | null> {
  const now = o.now ?? new Date();
  const entries = readLedger(o.ledger);
  if (haltReason(entries)) return "halted";
  if (o.idle && !o.idle()) return null;
  const mode = o.dryRun ? "dry_run" : "live";
  const ready = (i: Item) =>
    i.status === "approved" &&
    i.approvedFor === mode && // a dry-run approval never runs live, and the other way round
    now.getTime() - new Date(i.history.at(-1)!.at).getTime() >= (o.graceMs ?? 0) &&
    (o.dryRun || budgetCheck(entries, i.tool, now, o.limits).ok); // dry runs spend no budget
  const item = listItems(o.dir).find(ready);
  if (!item) return null;

  mkdirSync(o.shots, { recursive: true });
  const screenshot = join(o.shots, `${item.id}.png`);
  appendLedger(o.ledger, { at: now.toISOString(), event: "attempt", id: item.id, tool: item.tool, dryRun: o.dryRun });
  transition(o.dir, item.id, "posting", o.dryRun ? "dry run" : "live");

  let outcome: Status = o.dryRun ? "dry_run" : "posted";
  let detail: string | undefined;
  try {
    await o.run(item, screenshot, o.dryRun);
  } catch (e) {
    // A live error is "unknown" unless the flow proves it stopped before the final click:
    // the click may have landed before the error.
    outcome = o.dryRun || e instanceof NotSentError ? "failed" : "unknown";
    detail = e instanceof Error ? e.message : String(e);
    if (e instanceof BlockedError || (e instanceof Error && e.cause instanceof BlockedError)) {
      appendLedger(o.ledger, { at: new Date().toISOString(), event: "blocked", id: item.id, detail });
    }
  }
  transition(o.dir, item.id, outcome, detail);
  appendLedger(o.ledger, { at: new Date().toISOString(), event: "result", id: item.id, tool: item.tool, dryRun: o.dryRun, outcome, ...(detail && { detail }), screenshot });
  return outcome;
}

/** Polls every intervalMs. Never overlaps two ticks. Approvals get a 30 second undo window. */
export function startWorker(o: Omit<WorkerOptions, "now">, intervalMs = 10_000, onOutcome: (outcome: Status) => void = () => {}): () => void {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const outcome = await tick({ graceMs: 30_000, ...o });
      if (outcome && outcome !== "halted") {
        console.error(`[rednote-gate] worker: ${outcome}`);
        onOutcome(outcome);
      }
    } catch (e) {
      console.error("[rednote-gate] worker error:", e instanceof Error ? e.message : e);
    } finally {
      busy = false;
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
