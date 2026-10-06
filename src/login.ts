// One-time interactive login. Run headed: `npm run login`, scan the QR with the dedicated
// account's phone, then the session is saved and reused by the server.
import {
  getContext,
  newPage,
  saveSession,
  close,
  sessionPath,
} from "./session.js";
import { isLoggedIn } from "./rednote.js";

async function main() {
  if (process.env.RN_HEADLESS === "1") {
    console.error(
      "Run login headed (unset RN_HEADLESS) so you can scan the QR code.",
    );
    process.exit(1);
  }
  await getContext();
  const page = await newPage();
  await page.goto("https://www.xiaohongshu.com", {
    waitUntil: "domcontentloaded",
  });
  console.error(
    "A browser window opened. Log in to the DEDICATED account (QR or phone).\n" +
      "Waiting up to 3 minutes for login to complete…",
  );
  // Poll for the logged-in signal rather than a fixed sleep.
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (await isLoggedIn(page)) {
      await saveSession();
      console.error(
        `Logged in. Session saved to ${sessionPath()}. You can close this.`,
      );
      await close();
      process.exit(0);
    }
    await page.waitForTimeout(2000);
  }
  console.error("Timed out waiting for login. Re-run `npm run login`.");
  await close();
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
