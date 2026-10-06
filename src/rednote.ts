// The browser layer. Every DOM selector lives in SEL and is marked VERIFY until it has been run
// against the live site (see the "last verified" table in the README). Selectors and page-state
// paths were informed by xpzouying/xiaohongshu-mcp (Apache-2.0, a5c8f77) and sykuang/rednote-mcp
// (MIT, 7e87754). Reads use the page's own __INITIAL_STATE__ where possible: it changes less
// often than the DOM.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import { hasCookie, newPage, saveSession, site } from "./session.js";
import { BlockedError, NotSentError } from "./ledger.js";
import type { CommentArgs, Item, PostArgs, ReplyArgs } from "./queue.js";

const TYPE_MIN = Number(process.env.RN_TYPE_MIN_MS || 40);
const TYPE_MAX = Number(process.env.RN_TYPE_MAX_MS || 140);
const SITE = () => `https://www.${site()}`;
const CREATOR = () => `https://creator.${site()}`;
const HOSTS = ["www.xiaohongshu.com", "www.rednote.com"];

export const SEL = {
  loggedIn: ".main-container .user .link-wrapper .channel", // VERIFY
  // creator publish page
  imageTab: "div.creator-tab", // the tab whose text is exactly 上传图文 (VERIFY)
  uploadInput: ".upload-input, input[type=file]", // VERIFY
  uploadedImage: ".img-preview-area .pr", // one per uploaded image (VERIFY)
  postTitle: "div.d-input input", // VERIFY
  postBody: 'div[role="textbox"][contenteditable="true"], div.tiptap[contenteditable="true"], div.ql-editor', // VERIFY
  publishButton: 'xhs-publish-btn:not([is-publish="false"]), .publish-page-publish-btn button.bg-red', // VERIFY
  saveDraftButton: "button:text-is('暂存离开')", // VERIFY: a guess, no reference project saves drafts
  // note page
  commentOpen: "div.input-box div.content-edit span", // VERIFY
  commentInput: "div.input-box div.content-edit p.content-input", // VERIFY
  commentSubmit: "div.bottom button.submit", // VERIFY
  commentById: (id: string) => `#comment-${id}`, // VERIFY
  replyButton: ".right .interactions .reply", // VERIFY
};

// Text RedNote shows on a captcha or rate-limit page. Seeing any of it stops everything.
const BLOCK_TEXT = ["安全验证", "Security Verification", "拖动箭头完成拼图", "操作频繁", "访问频繁"];

const rand = (min: number, max: number) => Math.floor(min + Math.random() * (max - min));
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** Only RedNote note links that carry an xsec_token. A bare link triggers a captcha. */
export function parseNoteUrl(raw: string): { noteId: string; url: string } {
  const u = new URL(raw);
  const m = u.pathname.match(/^\/(?:explore|discovery\/item)\/([0-9a-zA-Z]{8,32})$/);
  if (u.protocol !== "https:" || !HOSTS.includes(u.hostname) || !m) {
    throw new Error("Not a RedNote note URL. Use a url returned by rednote_search.");
  }
  if (!u.searchParams.get("xsec_token")) {
    throw new Error("This note URL has no xsec_token. Bare note URLs trigger a captcha. Use the url returned by rednote_search.");
  }
  return { noteId: m[1], url: u.toString() };
}

/** RedNote's title rule: a CJK character counts 1, an ASCII character counts half. Max 20. */
export function titleLength(s: string): number {
  let units = 0;
  for (let i = 0; i < s.length; i++) units += s.charCodeAt(i) > 127 ? 2 : 1;
  return Math.floor((units + 1) / 2);
}

// Concurrency 1: every browser action waits for the previous one to finish.
let chain: Promise<unknown> = Promise.resolve();
let inFlight = 0;
let guard = () => {};
/** True when no browser action is running or waiting. The worker only starts a write then. */
export const browserIdle = () => inFlight === 0;
/** Runs inside the lock, right before each action, so a halt written meanwhile still stops it. */
export function setGuard(fn: () => void): void {
  guard = fn;
}
function serial<T>(fn: () => Promise<T>): Promise<T> {
  inFlight++;
  const task = async () => {
    guard();
    return fn();
  };
  const run = chain.then(task, task);
  chain = run.catch(() => {}).finally(() => inFlight--);
  return run;
}

/** A reply goes out only if the comment with that id still has exactly the author and text the human saw. */
export function sameComment(found: { author?: string; text?: string } | undefined, approved: { author: string; text: string }): boolean {
  if (!found || !squash(approved.text) || !squash(approved.author)) return false;
  return squash(found.text ?? "") === squash(approved.text) && squash(found.author ?? "") === squash(approved.author);
}

/** Read a field back before the final click: a topic or mention picker, or a stray key, must not
 *  change what the human approved. */
async function assertTyped(page: Page, selector: string, expected: string, input = false) {
  const el = page.locator(selector).first();
  const got = input ? await el.inputValue() : await el.innerText();
  if (squash(got) !== squash(expected)) {
    throw new Error(`A field reads "${squash(got).slice(0, 60)}" instead of the approved text. Not sending.`);
  }
}

function withPage<T>(fn: (page: Page) => Promise<T>, screenshot?: string): Promise<T> {
  return serial(async () => {
    const page = await newPage();
    try {
      const out = await fn(page);
      await saveSession().catch(() => {}); // keep rotated cookies
      return out;
    } finally {
      if (screenshot) await page.screenshot({ path: screenshot }).catch(() => {});
      await page.close().catch(() => {});
    }
  });
}

/** Where RedNote sends a browser it will not serve. null when the url looks like a normal page. */
export function pageProblem(url: string): string | null {
  const path = new URL(url).pathname;
  if (path === "/login" || path.startsWith("/website-login")) return "RedNote redirected to its login page: the session is not logged in. Run `npm run login`.";
  if (path.startsWith("/404")) return "RedNote says this page is not available (deleted, private, or an expired xsec_token). Search again for a fresh url.";
  return null;
}

async function assertNotBlocked(page: Page) {
  const url = page.url();
  const text = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
  const hit = BLOCK_TEXT.find((t) => text.includes(t)) ?? (/captcha/i.test(url) ? "a captcha page" : undefined);
  if (hit) throw new BlockedError(`RedNote showed "${hit}" at ${url.split("?")[0]}`);
}

/** The same page on this account's own domain: a login cookie only works on its own domain. */
const onSite = (url: string) => {
  const u = new URL(url);
  u.hostname = `${u.hostname.split(".")[0]}.${site()}`;
  return u.toString();
};

async function open(page: Page, url: string) {
  await page.goto(onSite(url), { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(rand(1200, 2500));
  await assertNotBlocked(page);
  const problem = pageProblem(page.url());
  if (problem) throw new Error(problem);
}

/** Type like a person: per-character delay plus the odd pause. */
async function typeHuman(page: Page, selector: string, text: string) {
  const el = page.locator(selector).first();
  await el.click({ timeout: 15_000 });
  for (const ch of text) {
    await el.pressSequentially(ch, { delay: rand(TYPE_MIN, TYPE_MAX) });
    if (Math.random() < 0.06) await page.waitForTimeout(rand(200, 600));
  }
}

/** Vue keeps some state in refs; this unwraps .value / ._value. */
const STATE_JS = `(path) => { let v = window.__INITIAL_STATE__; for (const k of path) { if (v == null) return undefined; v = v[k]; if (v && typeof v === "object" && ("_value" in v || "__v_isRef" in v)) v = v._value ?? v.value; } return v == null ? undefined : JSON.parse(JSON.stringify(v)); }`;
async function readState<T>(page: Page, path: string[], ready: (v: T | undefined) => boolean, timeout = 15_000): Promise<T | undefined> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = (await page.evaluate(`(${STATE_JS})(${JSON.stringify(path)})`).catch(() => undefined)) as T | undefined;
    if (ready(v) || Date.now() > deadline) return v;
    await page.waitForTimeout(500);
  }
}

// ─── Reads ──────────────────────────────────────────────────────────────────────────────────

/** The creator site is logged in when it keeps us on its page instead of sending us to /login.
 *  xiaohongshu.com also sets galaxy_creator_session_id; rednote.com has no such cookie. */
export async function creatorLoggedIn(page: Page): Promise<boolean> {
  const u = new URL(page.url());
  return (await hasCookie("galaxy_creator_session_id")) || (u.hostname.startsWith("creator.") && !pageProblem(page.url()));
}

export function loginStatus() {
  return withPage(async (page) => {
    await open(page, `${SITE()}/explore`);
    const loggedIn = await page.locator(SEL.loggedIn).first().isVisible({ timeout: 5_000 }).catch(() => false);
    await page.goto(`${CREATOR()}/publish/publish?source=official`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(rand(2500, 3500)); // the redirect to /login, if any, happens after load
    return { site: site(), loggedIn, creatorSession: await creatorLoggedIn(page) };
  });
}

export async function isLoggedIn(page: Page): Promise<boolean> {
  return page.locator(SEL.loggedIn).first().isVisible().catch(() => false);
}

type Feed = { id: string; xsecToken: string; modelType?: string; noteCard?: { displayTitle?: string; user?: { nickname?: string; nickName?: string }; interactInfo?: { likedCount?: string } } };

export function search(keyword: string, limit = 10) {
  return withPage(async (page) => {
    await open(page, `${SITE()}/search_result?keyword=${encodeURIComponent(keyword)}&source=web_explore_feed`);
    const feeds = await readState<Feed[]>(page, ["search", "feeds"], (v) => Array.isArray(v) && v.length > 0, 20_000);
    if (!feeds?.length) throw new Error("Search returned no notes. Check rednote_login_status: logged-out search shows a login wall.");
    return feeds
      .filter((f) => f.modelType === "note" && f.id && f.xsecToken)
      .slice(0, limit)
      .map((f) => ({
        noteId: f.id,
        title: f.noteCard?.displayTitle ?? "",
        author: f.noteCard?.user?.nickname ?? f.noteCard?.user?.nickName ?? "",
        likes: f.noteCard?.interactInfo?.likedCount ?? "",
        url: `${SITE()}/explore/${f.id}?xsec_token=${encodeURIComponent(f.xsecToken)}&xsec_source=pc_search`,
      }));
  });
}

type Comment = { id: string; content: string; likeCount?: string; subCommentCount?: string; userInfo?: { nickname?: string } };
type Detail = {
  note?: { title?: string; desc?: string; time?: number; ipLocation?: string; user?: { nickname?: string }; tagList?: { name: string }[]; interactInfo?: { likedCount?: string; collectedCount?: string; commentCount?: string } };
  comments?: { list?: Comment[]; firstRequestFinish?: boolean };
};

export function getNote(url: string) {
  const { noteId, url: noteUrl } = parseNoteUrl(url);
  return withPage(async (page) => {
    await open(page, noteUrl);
    const n = (await readState<Detail>(page, ["note", "noteDetailMap", noteId], (v) => !!v?.note))?.note;
    if (!n) throw new Error("The note page loaded but its data was not found. The page layout may have changed.");
    return {
      noteId,
      title: n.title ?? "",
      body: n.desc ?? "",
      author: n.user?.nickname ?? "",
      tags: (n.tagList ?? []).map((t) => t.name),
      likes: n.interactInfo?.likedCount,
      collects: n.interactInfo?.collectedCount,
      comments: n.interactInfo?.commentCount,
      ipLocation: n.ipLocation,
      time: n.time ? new Date(n.time).toISOString() : undefined,
      url: noteUrl,
    };
  });
}

export function getComments(url: string, limit = 20) {
  const { noteId, url: noteUrl } = parseNoteUrl(url);
  return withPage(async (page) => {
    await open(page, noteUrl);
    const d = await readState<Detail>(page, ["note", "noteDetailMap", noteId], (v) => !!v?.comments?.firstRequestFinish || !!v?.comments?.list?.length);
    return (d?.comments?.list ?? []).slice(0, limit).map((c) => ({
      id: c.id,
      author: c.userInfo?.nickname ?? "",
      text: c.content,
      likes: c.likeCount,
      replies: c.subCommentCount,
    }));
  });
}

// ─── Writes (called only by the worker, only for approved items) ───────────────────────────

type Progress = { clicked: boolean };

function publish(a: PostArgs, draft: boolean, screenshot: string, dryRun: boolean, p: Progress) {
  return withPage(async (page) => {
    await open(page, `${CREATOR()}/publish/publish?source=official`);
    if (!new URL(page.url()).pathname.startsWith("/publish")) throw new Error("The creator site is not logged in. Run `npm run login` again.");
    await page.locator(SEL.imageTab).filter({ hasText: /^\s*上传图文\s*$/ }).first().click({ timeout: 15_000 });
    await page.waitForTimeout(rand(800, 1500));
    await page.locator(SEL.uploadInput).first().setInputFiles(a.images);
    await page.waitForFunction(([sel, n]) => document.querySelectorAll(sel as string).length >= (n as number), [SEL.uploadedImage, a.images.length], { timeout: 60_000 });
    await typeHuman(page, SEL.postTitle, a.title);
    await typeHuman(page, SEL.postBody, a.body);
    await assertTyped(page, SEL.postTitle, a.title, true);
    await assertTyped(page, SEL.postBody, a.body);
    await assertNotBlocked(page);
    if (dryRun) return;
    const button = page.locator(draft ? SEL.saveDraftButton : SEL.publishButton).first();
    await button.waitFor({ state: "visible", timeout: 10_000 });
    p.clicked = true;
    await button.click();
    if (draft) await page.waitForTimeout(rand(2500, 4000));
    else await page.waitForURL((u) => !u.pathname.includes("/publish/publish"), { timeout: 30_000 }); // success leaves the page
    await assertNotBlocked(page);
  }, screenshot);
}

function comment(a: CommentArgs, screenshot: string, dryRun: boolean, p: Progress) {
  const { url } = parseNoteUrl(a.noteUrl);
  return withPage(async (page) => {
    await open(page, url);
    await page.locator(SEL.commentOpen).first().click({ timeout: 15_000 });
    await typeHuman(page, SEL.commentInput, a.text);
    await assertTyped(page, SEL.commentInput, a.text);
    if (dryRun) return;
    p.clicked = true;
    await page.locator(SEL.commentSubmit).first().click();
    await page.waitForTimeout(rand(2000, 3500));
    await assertNotBlocked(page);
  }, screenshot);
}

function reply(a: ReplyArgs, screenshot: string, dryRun: boolean, p: Progress) {
  const { noteId, url } = parseNoteUrl(a.noteUrl);
  if (!/^[0-9a-zA-Z]{8,32}$/.test(a.commentId)) throw new Error(`Bad comment id: ${a.commentId}`);
  return withPage(async (page) => {
    await open(page, url);
    // The human approved a reply to one author's exact words. Check both, from the page's own data.
    const list = (await readState<Comment[]>(page, ["note", "noteDetailMap", noteId, "comments", "list"], (v) => Array.isArray(v) && v.length > 0)) ?? [];
    const c = list.find((x) => x.id === a.commentId);
    if (!c) throw new Error(`Comment ${a.commentId} is not on the first page of comments, or it was deleted. Not replying.`);
    if (!sameComment({ author: c.userInfo?.nickname, text: c.content }, { author: a.commentAuthor, text: a.commentText })) {
      throw new Error("That comment's author or text no longer matches what you approved. Not replying.");
    }
    const target = page.locator(SEL.commentById(a.commentId)).first();
    await target.waitFor({ state: "attached", timeout: 15_000 });
    await target.scrollIntoViewIfNeeded();
    await target.locator(SEL.replyButton).first().click({ timeout: 10_000 });
    await typeHuman(page, SEL.commentInput, a.text);
    await assertTyped(page, SEL.commentInput, a.text);
    if (dryRun) return;
    p.clicked = true;
    await page.locator(SEL.commentSubmit).first().click();
    await page.waitForTimeout(rand(2000, 3500));
    await assertNotBlocked(page);
  }, screenshot);
}

/** The worker's Runner. Any error before the final click becomes NotSentError: provably nothing sent. */
export async function runWrite(item: Item, queueDir: string, screenshot: string, dryRun: boolean): Promise<void> {
  const p: Progress = { clicked: false };
  try {
    if (item.tool === "create_post" || item.tool === "create_draft") {
      const a = item.args as PostArgs;
      const images = a.images.map((rel) => join(queueDir, rel));
      images.forEach((path, n) => {
        if (createHash("sha256").update(readFileSync(path)).digest("hex") !== item.imageSha256?.[n]) {
          throw new Error(`Image ${n + 1} changed after it was queued. Not posting.`);
        }
      });
      await publish({ ...a, images }, item.tool === "create_draft", screenshot, dryRun, p);
    } else if (item.tool === "post_comment") {
      await comment(item.args as CommentArgs, screenshot, dryRun, p);
    } else {
      await reply(item.args as ReplyArgs, screenshot, dryRun, p);
    }
  } catch (e) {
    if (p.clicked || e instanceof NotSentError) throw e;
    throw new NotSentError(e instanceof Error ? e.message : String(e), { cause: e });
  }
}
