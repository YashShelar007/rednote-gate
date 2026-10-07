// The browser layer. Every DOM selector lives in SEL and is marked VERIFY until it has been run
// against the live site (see the "last verified" table in the README). Selectors and page-state
// paths were informed by xpzouying/xiaohongshu-mcp (Apache-2.0, a5c8f77) and sykuang/rednote-mcp
// (MIT, 7e87754). Reads use the page's own __INITIAL_STATE__ where possible: it changes less
// often than the DOM.
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import { hasCookie, newPage, saveSession, site } from "./session.js";
import { BlockedError, NotSentError } from "./ledger.js";
import { fileSha256, type CommentArgs, type Item, type LikeArgs, type PostArgs, type ReplyArgs, type VideoArgs } from "./queue.js";

const TYPE_MIN = Number(process.env.RN_TYPE_MIN_MS || 40);
const TYPE_MAX = Number(process.env.RN_TYPE_MAX_MS || 140);
const SITE = () => `https://www.${site()}`;
const CREATOR = () => `https://creator.${site()}`;
const HOSTS = ["www.xiaohongshu.com", "www.rednote.com"];

// RedNote plants hidden decoy copies of some buttons (aria-hidden, data-hp-kind; seen 2026-10-06 on
// the creator page). A person can never click them. We act only on what a person can see and click.
const SEEN = ':not([aria-hidden="true"]):not([data-hp-kind]):not([button-hp-installed])';
const NOT_DECOY = ":not([data-hp-kind]):not([button-hp-installed])";

export const SEL = {
  loggedIn: ".main-container .user .link-wrapper .channel", // verified 2026-10-06
  myProfileLink: `div.main-container li.user.side-bar-component a.link-wrapper${SEEN}`, // the sidebar "Me" link (VERIFY)
  // creator publish page
  imageTab: `div.creator-tab${SEEN}`, // the tab whose text is exactly 上传图文 (verified 2026-10-06)
  uploadInput: `.upload-input${NOT_DECOY}, input[type=file]${NOT_DECOY}`, // VERIFY
  uploadedImage: ".img-preview-area .pr", // one per uploaded image (VERIFY)
  postTitle: `div.d-input input${SEEN}`, // VERIFY
  postBody: `div[role="textbox"][contenteditable="true"]${SEEN}, div.tiptap[contenteditable="true"]${SEEN}, div.ql-editor${SEEN}`, // VERIFY
  // One element with closed shadow DOM holds both final buttons: 暂存离开 left, 发布 right (2026-10-06).
  publishBar: `xhs-publish-btn${SEEN}`, // verified present 2026-10-06; the click offsets below are VERIFY
  publishButton: `.publish-page-publish-btn button.bg-red${SEEN}`, // older layout fallback (VERIFY)
  saveDraftButton: `button:text-is('暂存离开')${SEEN}`, // older layout fallback (VERIFY)
  // note page
  commentOpen: `div.input-box div.content-edit span${SEEN}`, // VERIFY
  commentInput: `div.input-box div.content-edit p.content-input${SEEN}`, // VERIFY
  commentSubmit: `div.bottom button.submit${SEEN}`, // VERIFY
  commentById: (id: string) => `#comment-${id}`, // VERIFY
  replyButton: `.right .interactions .reply${SEEN}`, // VERIFY
  topicSuggestion: `#creator-editor-topic-container .item${NOT_DECOY}`, // the topic picker's entries (VERIFY)
  likeButton: `.interact-container .left .like-lottie${NOT_DECOY}`, // icons may be aria-hidden, so only decoys are excluded (VERIFY)
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
let lastUsed = 0;
let guard = () => {};
/** When the last browser action finished. */
export const lastActive = () => lastUsed;
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
  chain = run.catch(() => {}).finally(() => {
    inFlight--;
    lastUsed = Date.now();
  });
  return run;
}

/** A reply goes out only if the comment with that id still has exactly the author and text the human saw. */
export function sameComment(found: { author?: string; text?: string } | undefined, approved: { author: string; text: string }): boolean {
  if (!found || !squash(approved.text) || !squash(approved.author)) return false;
  return squash(found.text ?? "") === squash(approved.text) && squash(found.author ?? "") === squash(approved.author);
}

/** The body as approved, optionally followed by the approved topics (as plain #name or as linked
 *  chips such as "#name[话题]#"), and nothing else. */
export function bodyMatches(got: string, body: string, topics: string[]): boolean {
  const text = squash(got);
  if (!text.startsWith(squash(body))) return false;
  let rest = text.slice(squash(body).length);
  for (const t of topics) {
    const chip = new RegExp(`#${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\[话题\\]#)?(?=\\s|#|$)`, "u");
    if (!chip.test(rest)) return false;
    rest = rest.replace(chip, "");
  }
  return squash(rest) === "";
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

// One tab for everything, like a person browsing: a window per action flashes open and shut.
let tab: Page | null = null;

/** Writes pass a screenshot path; their tab is closed afterwards so a half-filled form is never reused. */
function withPage<T>(fn: (page: Page) => Promise<T>, screenshot?: string): Promise<T> {
  return serial(async () => {
    if (!tab || tab.isClosed()) tab = await newPage();
    const page = tab;
    try {
      const out = await fn(page);
      await saveSession().catch(() => {}); // keep rotated cookies
      return out;
    } finally {
      if (screenshot) {
        await page.screenshot({ path: screenshot }).catch(() => {});
        await page.close().catch(() => {});
        tab = null;
      }
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
  if (hit) throw new BlockedError(`"${hit}" at ${url.split("?")[0]}`); // callers say "RedNote showed"
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

/** The profile page keeps one list per tab (notes, collected, liked); the first is the user's own notes. */
export function notesFromProfile(tabs: Feed[][] | undefined, site: string, limit: number) {
  return (tabs?.[0] ?? [])
    .filter((f) => f.id && f.xsecToken)
    .slice(0, limit)
    .map((f) => ({
      noteId: f.id,
      title: f.noteCard?.displayTitle ?? "",
      likes: f.noteCard?.interactInfo?.likedCount ?? "",
      url: `${site}/explore/${f.id}?xsec_token=${encodeURIComponent(f.xsecToken)}&xsec_source=pc_user`,
    }));
}

/** The logged-in account's own notes, newest first, with urls the other tools accept. */
export function myNotes(limit = 10) {
  return withPage(async (page) => {
    await open(page, `${SITE()}/explore`);
    const href = await page.locator(SEL.myProfileLink).first().getAttribute("href", { timeout: 10_000 });
    if (!href?.includes("/user/profile/")) throw new Error("Could not find the link to your profile. Check rednote_login_status.");
    await open(page, new URL(href, SITE()).toString());
    const tabs = await readState<Feed[][]>(page, ["user", "notes"], (v) => Array.isArray(v) && Array.isArray(v[0]), 10_000);
    return notesFromProfile(tabs, SITE(), limit);
  });
}

type Comment = { id: string; content: string; likeCount?: string; subCommentCount?: string; userInfo?: { nickname?: string } };
type Detail = {
  note?: { title?: string; desc?: string; time?: number; ipLocation?: string; user?: { nickname?: string }; tagList?: { name: string }[]; interactInfo?: { liked?: boolean; likedCount?: string; collectedCount?: string; commentCount?: string } };
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
    for (const t of a.topics ?? []) await addTopic(page, t);
    if (a.aiGenerated) await addAiLabel(page);
    await assertTyped(page, SEL.postTitle, a.title, true);
    const typed = await page.locator(SEL.postBody).first().innerText();
    if (!bodyMatches(typed, a.body, a.topics ?? [])) throw new Error(`The body reads "${squash(typed).slice(0, 80)}" instead of the approved text and topics. Not sending.`);
    await assertNotBlocked(page);
    // Find the final button even in a dry run, so a broken selector shows up before the first real post.
    const { target, position } = await finalPublishButton(page, draft);
    if (dryRun) return;
    p.clicked = true;
    await target.click(position ? { position } : {});
    if (draft) await page.waitForTimeout(rand(2500, 4000));
    else await page.waitForURL((u) => !u.pathname.includes("/publish/publish"), { timeout: 30_000 }); // success leaves the page
    await assertNotBlocked(page);
  }, screenshot);
}

/** RedNote's own AI label: 内容类型声明, then 笔记含AI合成内容 (its documented publish flow, 2025-09-01).
 *  Throws before the final click if the label cannot be set, so a labelled item never goes out without it. */
async function addAiLabel(page: Page) {
  // ponytail: found by visible text, unverified on the live page until the first dry run with the label.
  await page.locator(`:is(div,span,button)${SEEN}`).filter({ hasText: /^\s*(添加)?内容类型声明\s*$/ }).last().click({ timeout: 10_000 });
  await page.waitForTimeout(rand(500, 900));
  await page.locator(`:is(div,span,li,label)${SEEN}`).filter({ hasText: /^\s*笔记含AI合成内容\s*$/ }).last().click({ timeout: 10_000 });
  await page.waitForTimeout(rand(500, 900));
  if (!(await page.locator(`:is(div,span)${SEEN}`).filter({ hasText: /笔记含AI合成内容/ }).first().isVisible())) throw new Error("RedNote's AI label (笔记含AI合成内容) did not stick. Not sending.");
}

/** Types "#topic" at the end of the body. If the picker offers exactly that topic, click it so it
 *  becomes a linked topic; otherwise leave it as plain text. Never picks a different topic. */
async function addTopic(page: Page, topic: string) {
  await page.locator(SEL.postBody).first().focus();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
  // The picker needs a beat after "#" and after a previous topic, or typed characters get lost.
  await page.keyboard.type(" ");
  await page.waitForTimeout(rand(300, 500));
  await page.keyboard.type("#");
  await page.waitForTimeout(rand(500, 800));
  for (const ch of topic) await page.keyboard.type(ch, { delay: rand(TYPE_MIN, TYPE_MAX) });
  const exact = page.locator(SEL.topicSuggestion).filter({ hasText: new RegExp(`^\\s*#?${topic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`, "u") }).first();
  // The list loads for 1 to 2 seconds. isVisible() does not wait, so wait explicitly.
  const offered = await exact.waitFor({ state: "visible", timeout: 6_000 }).then(() => true, () => false);
  if (offered) await exact.click();
  else await page.keyboard.type(" ");
  await page.waitForTimeout(rand(900, 1300)); // let the picker close before the next topic
}

/** The publish bar's buttons sit 72px either side of its centre (measured 2026-10-06). Its own
 *  attributes name them, so check those first: if the layout changed, stop rather than click blind. */
async function finalPublishButton(page: Page, draft: boolean, waitMs = 20_000): Promise<{ target: Locator; position?: { x: number; y: number } }> {
  const bar = page.locator(SEL.publishBar).first();
  if ((await bar.count()) === 0) {
    const target = page.locator(draft ? SEL.saveDraftButton : SEL.publishButton).first();
    await target.waitFor({ state: "visible", timeout: 10_000 });
    return { target };
  }
  const [label, disabled, want] = draft ? ["save-text", "save-disabled", "暂存离开"] : ["submit-text", "submit-disabled", "发布"];
  if ((await bar.getAttribute(label)) !== want) throw new Error(`The publish bar no longer has a "${want}" button. Not clicking.`);
  for (const end = Date.now() + waitMs; (await bar.getAttribute(disabled)) !== "false"; ) {
    if (Date.now() > end) throw new Error(`The "${want}" button stayed disabled.`);
    await page.waitForTimeout(500);
  }
  await bar.scrollIntoViewIfNeeded();
  const box = await bar.boundingBox();
  if (!box) throw new Error("The publish bar is not on screen.");
  return { target: bar, position: { x: box.width / 2 + (draft ? -72 : 72), y: box.height / 2 } };
}

/** A video note: upload on the 上传视频 tab, fill the form, then wait (up to 10 minutes) for RedNote
 *  to finish processing, which is when it enables 发布. */
function publishVideo(a: VideoArgs, screenshot: string, dryRun: boolean, p: Progress) {
  return withPage(async (page) => {
    await open(page, `${CREATOR()}/publish/publish?source=official`);
    if (!new URL(page.url()).pathname.startsWith("/publish")) throw new Error("The creator site is not logged in. Run `npm run login` again.");
    await page.locator(SEL.imageTab).filter({ hasText: /^\s*上传视频\s*$/ }).first().click({ timeout: 15_000 });
    await page.waitForTimeout(rand(800, 1500));
    await page.locator(SEL.uploadInput).first().setInputFiles(a.video);
    await page.locator(SEL.postTitle).first().waitFor({ state: "visible", timeout: 120_000 }); // the form appears once the upload starts
    await typeHuman(page, SEL.postTitle, a.title);
    await typeHuman(page, SEL.postBody, a.body);
    for (const t of a.topics ?? []) await addTopic(page, t);
    if (a.aiGenerated) await addAiLabel(page);
    await assertTyped(page, SEL.postTitle, a.title, true);
    const typed = await page.locator(SEL.postBody).first().innerText();
    if (!bodyMatches(typed, a.body, a.topics ?? [])) throw new Error(`The body reads "${squash(typed).slice(0, 80)}" instead of the approved text and topics. Not sending.`);
    await assertNotBlocked(page);
    const { target, position } = await finalPublishButton(page, false, 10 * 60_000);
    if (dryRun) return;
    p.clicked = true;
    await target.click(position ? { position } : {});
    await page.waitForURL((u) => !u.pathname.includes("/publish/publish"), { timeout: 60_000 });
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
    const send = page.locator(SEL.commentSubmit).first();
    await send.waitFor({ state: "visible", timeout: 10_000 });
    if (dryRun) return;
    p.clicked = true;
    await send.click();
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
    const send = page.locator(SEL.commentSubmit).first();
    await send.waitFor({ state: "visible", timeout: 10_000 });
    if (dryRun) return;
    p.clicked = true;
    await send.click();
    await page.waitForTimeout(rand(2000, 3500));
    await assertNotBlocked(page);
  }, screenshot);
}

function like(a: LikeArgs, screenshot: string, dryRun: boolean, p: Progress) {
  const { noteId, url } = parseNoteUrl(a.noteUrl);
  return withPage(async (page) => {
    await open(page, url);
    const liked = async () => (await readState<Detail>(page, ["note", "noteDetailMap", noteId], (v) => !!v?.note))?.note?.interactInfo?.liked;
    if (await liked()) throw new Error("This note is already liked. Nothing to do.");
    const button = page.locator(SEL.likeButton).first();
    await button.waitFor({ state: "visible", timeout: 10_000 });
    if (dryRun) return;
    p.clicked = true;
    await button.click();
    await page.waitForTimeout(rand(1500, 2500));
    await assertNotBlocked(page);
    if (!(await liked())) throw new Error("Clicked like, but the note does not show as liked. Check it in the app.");
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
        if (fileSha256(path) !== item.imageSha256?.[n]) {
          throw new Error(`Image ${n + 1} changed after it was queued. Not posting.`);
        }
      });
      await publish({ ...a, images }, item.tool === "create_draft", screenshot, dryRun, p);
    } else if (item.tool === "create_video") {
      const a = item.args as VideoArgs;
      const video = join(queueDir, a.video);
      if (fileSha256(video) !== item.videoSha256) throw new Error("The video changed after it was queued. Not posting.");
      await publishVideo({ ...a, video }, screenshot, dryRun, p);
    } else if (item.tool === "like_note") {
      await like(item.args as LikeArgs, screenshot, dryRun, p);
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
