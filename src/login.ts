// One-time interactive login: `npm run login`. Scan the QR with the THROWAWAY account's phone.
// Saves .session/state.json (owner-only) and which site the account uses. Never prints secrets.
import { DATA_DIR, acquireLock, close, hasCookie, newPage, saveSession, saveSite, type Site } from "./session.js";
import { isLoggedIn } from "./rednote.js";

const CREATOR_COOKIE = "galaxy_creator_session_id";
const siteOf = (url: string): Site => (new URL(url).hostname.endsWith("rednote.com") ? "rednote.com" : "xiaohongshu.com");

async function main() {
  if (process.env.RN_HEADLESS === "1") {
    console.error("Run login headed (unset RN_HEADLESS) so you can scan the QR code.");
    process.exit(1);
  }
  const lock = acquireLock(DATA_DIR);
  if (!lock.ok) {
    console.error(`rednote-gate is running (pid ${lock.pid}). Quit your MCP client first, then run login again.`);
    process.exit(1);
  }
  let presses = 0;
  process.stdin.on("data", () => presses++);

  const page = await newPage();
  await page.goto(`https://www.${process.env.RN_SITE || "xiaohongshu.com"}/explore`, { waitUntil: "domcontentloaded" });
  console.error("A browser window opened. Scan the QR code with the THROWAWAY account's phone.");
  console.error("If the page shows you logged in but nothing happens here, press Enter.");

  let moved = false;
  for (const end = Date.now() + 240_000; Date.now() < end && presses === 0 && !(await isLoggedIn(page)); ) {
    const u = new URL(page.url());
    // Overseas accounts are sent to rednote.com with a redirect back to xiaohongshu.com, where the
    // new login cookie does not apply. Restart the login on rednote.com so it stays on one domain.
    if (!moved && u.hostname.endsWith("rednote.com") && (u.searchParams.get("redirectPath") ?? "").includes("xiaohongshu.com")) {
      moved = true;
      console.error("This account uses rednote.com. Reloading the login there: scan the NEW QR code.");
      await page.goto("https://www.rednote.com/explore", { waitUntil: "domcontentloaded" });
    }
    await page.waitForTimeout(2000);
  }
  if (presses === 0 && !(await isLoggedIn(page))) {
    console.error("Timed out waiting for login. Run `npm run login` again.");
    await close();
    process.exit(1);
  }

  const s = siteOf(page.url());
  saveSite(s);
  console.error(`Logged in on ${s}. Opening the creator site to pick up its session. If it asks you to log in, scan again.`);
  await page.goto(`https://creator.${s}/?source=official`, { waitUntil: "domcontentloaded" });
  const before = presses;
  for (const end = Date.now() + 120_000; Date.now() < end && presses === before && !(await hasCookie(CREATOR_COOKIE)); ) {
    await page.waitForTimeout(2000);
  }
  const creator = await hasCookie(CREATOR_COOKIE);
  await saveSession();
  console.error(creator ? "Saved. You can close this window." : "Saved, but the creator site is not logged in, so publishing will fail. Run `npm run login` again.");
  await close();
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  await close();
  process.exit(1);
});
