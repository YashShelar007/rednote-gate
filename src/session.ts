// Playwright session manager: one browser, one logged-in RedNote context, persisted to disk.
// The storageState file is a credential — see .gitignore.
import { chromium, Browser, BrowserContext, Page } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SESSION_PATH = process.env.RN_SESSION_PATH || "./.session/state.json";
const HEADLESS = process.env.RN_HEADLESS === "1";

let browser: Browser | null = null;
let context: BrowserContext | null = null;

export function sessionPath(): string {
  return SESSION_PATH;
}

export function hasSavedSession(): boolean {
  return existsSync(SESSION_PATH);
}

/** Launch (once) and return a context that reuses the saved login if present. */
export async function getContext(): Promise<BrowserContext> {
  if (context) return context;
  browser = await chromium.launch({
    headless: HEADLESS,
    args: ["--disable-blink-features=AutomationControlled"], // light anti-detection
  });
  context = await browser.newContext({
    storageState: hasSavedSession() ? SESSION_PATH : undefined,
    viewport: { width: 1280, height: 900 },
    locale: "zh-CN",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });
  return context;
}

export async function newPage(): Promise<Page> {
  const ctx = await getContext();
  return ctx.newPage();
}

/** Persist the current cookies/localStorage to disk so later runs skip login. */
export async function saveSession(): Promise<void> {
  if (!context) return;
  const dir = dirname(SESSION_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  await context.storageState({ path: SESSION_PATH });
}

export async function close(): Promise<void> {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  context = null;
  browser = null;
}
