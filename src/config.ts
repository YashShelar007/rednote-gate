// Settings shared by the MCP server and the service. Read once from the environment.
import { execFile } from "node:child_process";
import { join } from "node:path";
import type { Limits } from "./ledger.js";
import { loadSettings, type Settings } from "./settings.js";
import { DATA_DIR } from "./session.js";

export const DATA = DATA_DIR;
export const QUEUE = join(DATA, "queue");
export const LEDGER = join(DATA, "ledger.jsonl");
export const SHOTS = join(DATA, "screenshots");
export const URL_FILE = join(DATA, "approval-url");
export const SETTINGS_FILE = join(DATA, "settings.json");

/** Limits, mode and toggles as they are right now: the dashboard can change them at any time. */
export const current = (): Settings => loadSettings(SETTINGS_FILE);
export const limitsOf = (s: Settings): Limits => ({ daily: s.daily, likes: s.likes, commentGapMin: s.commentGapMin });

/** A typo in a limit must stop the program, never mean "no limit". */
function whole(name: string, fallback: number): number {
  const raw = process.env[name] ?? String(fallback);
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number, 0 or more. Got "${raw}".`);
  return n;
}
export const PORT = whole("RN_APPROVAL_PORT", 7317);

/** A Mac notification. Fixed wording only: never note text or secrets. Off in settings or RN_NOTIFY=0. */
export function notify(message: string): void {
  if (!current().notify || process.platform !== "darwin") return;
  execFile("osascript", ["-e", `display notification ${JSON.stringify(message)} with title "rednote-gate"`], () => {});
}

export const log = (msg: string) => console.error(`[rednote-gate] ${new Date().toISOString()} ${msg}`);
