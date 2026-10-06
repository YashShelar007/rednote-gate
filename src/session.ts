// One browser, one context, one account. The saved session (Playwright storageState) is a
// credential: owner-only permissions, git-ignored, never printed.
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The repo root, so paths work no matter which folder the MCP client starts us from. */
export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DATA_DIR = process.env.RN_DATA_DIR || join(ROOT, "data");
const SESSION_PATH = process.env.RN_SESSION_PATH || join(ROOT, ".session", "state.json");
const SITE_FILE = join(dirname(SESSION_PATH), "site");
const HEADLESS = process.env.RN_HEADLESS === "1";

/** Mainland accounts live on xiaohongshu.com, overseas accounts on rednote.com. Same backend, but
 *  the login cookie only works on its own domain. `npm run login` records which one this account uses. */
export type Site = "xiaohongshu.com" | "rednote.com";
export function site(): Site {
  const s = (process.env.RN_SITE || (existsSync(SITE_FILE) ? readFileSync(SITE_FILE, "utf8") : "xiaohongshu.com")).trim();
  if (s !== "xiaohongshu.com" && s !== "rednote.com") throw new Error(`RN_SITE must be xiaohongshu.com or rednote.com, not "${s}".`);
  return s;
}
export function saveSite(s: Site): void {
  mkdirSync(dirname(SITE_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(SITE_FILE, `${s}\n`);
}

let browser: Browser | null = null;
let context: Promise<BrowserContext> | null = null;

export function hasSavedSession(): boolean {
  return existsSync(SESSION_PATH);
}

async function launch(): Promise<BrowserContext> {
  browser = await chromium.launch({
    headless: HEADLESS,
    // Disclosed in the README: hides the "controlled by automated software" flag.
    args: ["--disable-blink-features=AutomationControlled"],
  });
  return browser.newContext({
    storageState: hasSavedSession() ? SESSION_PATH : undefined,
    viewport: { width: 1280, height: 900 },
    locale: "zh-CN",
    // Disclosed in the README: a fixed desktop Chrome UA, older than the Chromium Playwright runs.
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });
}

/** Launches once. Concurrent callers share the same promise, so there is never a second browser. */
export function getContext(): Promise<BrowserContext> {
  context ??= launch();
  return context;
}

/** True while a browser is running. The service closes it after a few idle minutes. */
export const browserOpen = () => context !== null;

export async function newPage(): Promise<Page> {
  return (await getContext()).newPage();
}

export async function hasCookie(name: string): Promise<boolean> {
  return (await (await getContext()).cookies()).some((c) => c.name === name && c.value);
}

/** Persists cookies and localStorage so later runs skip the QR login. */
export async function saveSession(): Promise<void> {
  if (!context) return;
  mkdirSync(dirname(SESSION_PATH), { recursive: true, mode: 0o700 });
  await (await context).storageState({ path: SESSION_PATH });
  chmodSync(SESSION_PATH, 0o600);
}

export async function close(): Promise<void> {
  const ctx = context;
  context = null;
  if (ctx) await (await ctx).close().catch(() => {});
  await browser?.close().catch(() => {});
  browser = null;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** One process may drive the account. A second MCP client gets { ok: false } and stays read-only.
 *  ponytail: two processes racing on a stale lock can both win; fine for one person's laptop. */
export function acquireLock(dir: string): { ok: true } | { ok: false; pid: number } {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "lock");
  try {
    writeFileSync(path, String(process.pid), { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const pid = Number(readFileSync(path, "utf8"));
    if (pid && pid !== process.pid && alive(pid)) return { ok: false, pid };
    writeFileSync(path, String(process.pid)); // stale lock from a crashed process
  }
  process.on("exit", () => {
    try {
      if (readFileSync(path, "utf8") === String(process.pid)) unlinkSync(path);
    } catch {
      // already gone
    }
  });
  return { ok: true };
}
