// The automation layer. EVERY DOM selector lives in SEL and is marked VERIFY: RedNote changes
// its UI, so when a flow breaks this is the one place to fix. The flows are written by reference
// to the open-source servers (see README Credits) and must be verified headed on first run.
import type { Page } from "playwright";
import { newPage } from "./session.js";

const DRY_RUN = process.env.RN_DRY_RUN !== "0"; // default ON — see README
const TYPE_MIN = Number(process.env.RN_TYPE_MIN_MS || 40);
const TYPE_MAX = Number(process.env.RN_TYPE_MAX_MS || 140);

const SITE = "https://www.xiaohongshu.com";
const CREATOR = "https://creator.xiaohongshu.com";

// ─── SELECTORS — VERIFY ALL OF THESE HEADED ON FIRST RUN ──────────────────────────────────────
const SEL = {
  // logged-in signal on www: the user avatar in the top bar (VERIFY)
  loggedInAvatar: ".main-container .user .avatar, .side-bar .user",
  searchInput: "input#search-input, input[placeholder*='搜索']", // VERIFY
  searchResultCard: "section.note-item, a[href*='/explore/']", // VERIFY
  noteTitle: "#detail-title, .note-content .title", // VERIFY
  noteBody: "#detail-desc, .note-content .desc", // VERIFY
  commentItem: ".comment-item, .list-container .comment", // VERIFY
  commentText: ".content, .comment-item .note-text", // VERIFY
  // creator publish page (VERIFY — this is the fragile, high-stakes part)
  uploadInput: "input[type=file]", // VERIFY
  postTitleInput: "input[placeholder*='标题'], .title input", // VERIFY
  postBodyInput: ".ql-editor, [contenteditable=true]", // VERIFY
  publishButton: "button:has-text('发布'), .publish-btn", // VERIFY
  saveDraftButton: "button:has-text('存草稿'), button:has-text('草稿')", // VERIFY
  // comment box on a note (VERIFY)
  commentBox:
    ".comment-input [contenteditable=true], textarea[placeholder*='评论']", // VERIFY
  commentSend: "button:has-text('发送'), .submit", // VERIFY
  replyTrigger: ".reply", // click on a comment to reply (VERIFY)
};

function rand(min: number, max: number) {
  return Math.floor(min + Math.random() * (max - min));
}

/** Type like a person: per-char delay + occasional longer pause. Reduces bot-flagging. */
async function typeHuman(page: Page, selector: string, text: string) {
  const el = page.locator(selector).first();
  await el.click();
  for (const ch of text) {
    await el.type(ch, { delay: rand(TYPE_MIN, TYPE_MAX) });
    if (Math.random() < 0.06) await page.waitForTimeout(rand(200, 600));
  }
}

export async function isLoggedIn(page: Page): Promise<boolean> {
  // A logged-out www shows a login modal / "登录" button; logged-in shows the avatar. (VERIFY)
  try {
    await page.waitForSelector(SEL.loggedInAvatar, { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

export async function loginStatus(): Promise<{ loggedIn: boolean }> {
  const page = await newPage();
  try {
    await page.goto(SITE, { waitUntil: "domcontentloaded" });
    return { loggedIn: await isLoggedIn(page) };
  } finally {
    await page.close();
  }
}

export async function search(keyword: string, limit = 10) {
  const page = await newPage();
  try {
    await page.goto(
      `${SITE}/search_result?keyword=${encodeURIComponent(keyword)}`,
      {
        waitUntil: "domcontentloaded",
      },
    );
    await page.waitForSelector(SEL.searchResultCard, { timeout: 20000 });
    const cards = page.locator(SEL.searchResultCard);
    const n = Math.min(await cards.count(), limit);
    const out: Array<{ title: string; url: string }> = [];
    for (let i = 0; i < n; i++) {
      const c = cards.nth(i);
      const title = (await c.innerText().catch(() => "")).trim().slice(0, 200);
      const href = (await c.getAttribute("href").catch(() => "")) || "";
      out.push({
        title,
        url: href.startsWith("http") ? href : `${SITE}${href}`,
      });
    }
    return out;
  } finally {
    await page.close();
  }
}

export async function getNote(url: string) {
  const page = await newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const title = await page
      .locator(SEL.noteTitle)
      .first()
      .innerText()
      .catch(() => "");
    const body = await page
      .locator(SEL.noteBody)
      .first()
      .innerText()
      .catch(() => "");
    return { url, title: title.trim(), body: body.trim() };
  } finally {
    await page.close();
  }
}

export async function getComments(url: string, limit = 20) {
  const page = await newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page
      .waitForSelector(SEL.commentItem, { timeout: 15000 })
      .catch(() => {});
    const items = page.locator(SEL.commentItem);
    const n = Math.min(await items.count(), limit);
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const t = await items
        .nth(i)
        .locator(SEL.commentText)
        .first()
        .innerText()
        .catch(() => "");
      if (t.trim()) out.push(t.trim());
    }
    return out;
  } finally {
    await page.close();
  }
}

/** Shared publish flow for create_post (stopAtDraft=false) and create_draft (true). */
async function publishFlow(args: {
  title: string;
  body: string;
  images: string[];
  stopAtDraft: boolean;
}) {
  if (!args.images?.length)
    throw new Error("RedNote photo notes require at least one image path.");
  const page = await newPage();
  try {
    await page.goto(`${CREATOR}/publish/publish`, {
      waitUntil: "domcontentloaded",
    });
    await page.setInputFiles(SEL.uploadInput, args.images);
    await page.waitForTimeout(rand(1500, 3000)); // let uploads settle (VERIFY: wait on a thumbnail)
    await typeHuman(page, SEL.postTitleInput, args.title);
    await typeHuman(page, SEL.postBodyInput, args.body);
    const finalSel = args.stopAtDraft ? SEL.saveDraftButton : SEL.publishButton;
    if (DRY_RUN) {
      return {
        dryRun: true,
        wouldClick: finalSel,
        note: "DRY RUN — fields filled, final button NOT clicked. Set RN_DRY_RUN=0 to go live.",
      };
    }
    await page.locator(finalSel).first().click();
    await page.waitForTimeout(rand(2000, 4000));
    return {
      dryRun: false,
      action: args.stopAtDraft ? "draft_saved" : "published",
    };
  } finally {
    await page.close();
  }
}

export const createPost = (a: {
  title: string;
  body: string;
  images: string[];
}) => publishFlow({ ...a, stopAtDraft: false });
export const createDraft = (a: {
  title: string;
  body: string;
  images: string[];
}) => publishFlow({ ...a, stopAtDraft: true });

export async function postComment(noteUrl: string, text: string) {
  const page = await newPage();
  try {
    await page.goto(noteUrl, { waitUntil: "domcontentloaded" });
    await typeHuman(page, SEL.commentBox, text);
    if (DRY_RUN)
      return { dryRun: true, note: "DRY RUN — comment typed, not sent." };
    await page.locator(SEL.commentSend).first().click();
    await page.waitForTimeout(rand(1500, 3000));
    return { dryRun: false, action: "comment_posted" };
  } finally {
    await page.close();
  }
}

export async function replyComment(
  noteUrl: string,
  commentIndex: number,
  text: string,
) {
  const page = await newPage();
  try {
    await page.goto(noteUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(SEL.commentItem, { timeout: 15000 });
    await page
      .locator(SEL.commentItem)
      .nth(commentIndex)
      .locator(SEL.replyTrigger)
      .first()
      .click();
    await typeHuman(page, SEL.commentBox, text);
    if (DRY_RUN)
      return { dryRun: true, note: "DRY RUN — reply typed, not sent." };
    await page.locator(SEL.commentSend).first().click();
    await page.waitForTimeout(rand(1500, 3000));
    return { dryRun: false, action: "reply_posted" };
  } finally {
    await page.close();
  }
}
