// One-time interactive login: `npm run login`. Scan the QR with the THROWAWAY account's phone.
// Saves .session/state.json (owner-only). Never prints its contents.
import { close, hasCookie, newPage, saveSession } from "./session.js";
import { isLoggedIn } from "./rednote.js";

const CREATOR_COOKIE = "galaxy_creator_session_id";

async function waitFor(check: () => Promise<boolean>, ms: number, enter: Promise<unknown>): Promise<boolean> {
  let pressed = false;
  enter.then(() => (pressed = true));
  for (const end = Date.now() + ms; Date.now() < end && !pressed; ) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return pressed || check();
}

async function main() {
  if (process.env.RN_HEADLESS === "1") {
    console.error("Run login headed (unset RN_HEADLESS) so you can scan the QR code.");
    process.exit(1);
  }
  const page = await newPage();
  await page.goto("https://www.xiaohongshu.com/explore", { waitUntil: "domcontentloaded" });
  console.error("A browser window opened. Scan the QR code with the THROWAWAY account's phone.");
  console.error("Waiting up to 3 minutes. If the page shows you logged in but this does not move on, press Enter here.");
  const enter = new Promise((r) => process.stdin.once("data", r));
  if (!(await waitFor(() => isLoggedIn(page), 180_000, enter))) {
    console.error("Timed out waiting for login. Run `npm run login` again.");
    await close();
    process.exit(1);
  }

  console.error("Logged in. Opening the creator site to pick up its session. If it asks you to log in, scan again.");
  await page.goto("https://creator.xiaohongshu.com/?source=official", { waitUntil: "domcontentloaded" });
  const creator = await waitFor(() => hasCookie(CREATOR_COOKIE), 120_000, new Promise((r) => process.stdin.once("data", r)));
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
