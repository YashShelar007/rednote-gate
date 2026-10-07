// The service: the one long-running process that owns the browser, the approval page and the
// worker. It outlives MCP clients, so the approval page always works and approved items always
// run. MCP servers start it on demand (see index.ts); `npm run stop` stops it.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import * as rn from "./rednote.js";
import { acquireLock, browserOpen, close } from "./session.js";
import { recoverInterrupted } from "./queue.js";
import { BlockedError, appendLedger, haltReason, readLedger } from "./ledger.js";
import { startWorker } from "./worker.js";
import { startApproval } from "./approval.js";
import { DATA, LEDGER, PORT, QUEUE, SETTINGS_FILE, SHOTS, URL_FILE, current, limitsOf, log, notify } from "./config.js";

const IDLE_CLOSE_MS = 5 * 60_000; // close the browser window after 5 quiet minutes
const STOPPED = "Stopped: RedNote showed a captcha or a warning. Check the account, then press Resume.";

mkdirSync(QUEUE, { recursive: true, mode: 0o700 }); // owner-only: queue text, ledger, approval link
const lock = acquireLock(DATA);
if (!lock.ok) {
  log(`already running (pid ${lock.pid}).`);
  process.exit(0);
}

const halted = () => {
  const halt = haltReason(readLedger(LEDGER));
  if (halt) throw new Error(`Stopped after RedNote showed: ${halt}. A human must check the account and press Resume on the approval page.`);
};
rn.setGuard(halted);

/** Reads: refused while halted; a captcha writes a blocked line, notifies, and is never retried. */
function guarded<A>(fn: (a: A) => Promise<unknown>) {
  return async (a: A) => {
    halted();
    try {
      return await fn(a);
    } catch (e) {
      if (e instanceof BlockedError) {
        appendLedger(LEDGER, { at: new Date().toISOString(), event: "blocked", detail: e.message });
        notify(STOPPED);
        throw new Error(`${e.message}. Stopped; not retrying. Check the account in the app, then press Resume on the approval page.`);
      }
      throw e;
    }
  };
}
const reads = {
  login_status: guarded(() => rn.loginStatus()),
  search: guarded((a: { keyword: string; limit?: number }) => rn.search(String(a.keyword), a.limit ?? 10)),
  get_note: guarded((a: { url: string }) => rn.getNote(String(a.url))),
  get_comments: guarded((a: { url: string; limit?: number }) => rn.getComments(String(a.url), a.limit ?? 20)),
  my_notes: guarded((a: { limit?: number }) => rn.myNotes(a.limit ?? 10)),
};

const SAY: Partial<Record<string, string>> = {
  posted: "Done. It went out. The screenshot is on the approval page.",
  dry_run: "Dry run finished. Nothing was published. The screenshot is on the approval page.",
  failed: "A write stopped before sending. Nothing was posted. Details on the approval page.",
  unknown: "A write may or may not have gone out. Check the RedNote app.",
};

async function main() {
  for (const i of recoverInterrupted(QUEUE)) {
    appendLedger(LEDGER, { at: new Date().toISOString(), event: "result", id: i.id, tool: i.tool, outcome: i.status, detail: i.history.at(-1)?.note });
    log(`${i.id} was cut off mid-attempt; marked ${i.status}.`);
  }
  const token = randomBytes(24).toString("hex");
  // Getters, not values: the page and the worker see a settings change on their next request or tick.
  const { server, port } = await startApproval({
    dir: QUEUE,
    ledger: LEDGER,
    shots: SHOTS,
    token,
    port: PORT,
    reads,
    settingsFile: SETTINGS_FILE,
    get limits() {
      return limitsOf(current());
    },
    get dryRun() {
      return current().dryRun;
    },
  });
  writeFileSync(URL_FILE, `http://127.0.0.1:${port}/?t=${token}\n`, { mode: 0o600 });
  chmodSync(URL_FILE, 0o600);

  const stopWorker = startWorker(
    {
      dir: QUEUE,
      ledger: LEDGER,
      shots: SHOTS,
      idle: rn.browserIdle,
      run: (item, shot, dry) => rn.runWrite(item, QUEUE, shot, dry),
      get limits() {
        return limitsOf(current());
      },
      get dryRun() {
        return current().dryRun;
      },
    },
    10_000,
    (outcome) => notify(haltReason(readLedger(LEDGER)) ? STOPPED : SAY[outcome] ?? `Finished: ${outcome}.`),
  );
  const idle = setInterval(() => {
    if (browserOpen() && rn.browserIdle() && Date.now() - rn.lastActive() > IDLE_CLOSE_MS) close().catch(() => {});
  }, 60_000);
  log(`service up on 127.0.0.1:${port}, pid ${process.pid}. Mode: ${current().dryRun ? "dry run" : "LIVE"} (changes in the dashboard apply live).`);

  const shutdown = async () => {
    clearInterval(idle);
    stopWorker();
    server.close();
    await close();
    log("service stopped.");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  log(`service failed to start: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
