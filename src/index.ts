// MCP stdio server. Reads run directly. Write tools only queue; a human approves each item on
// the localhost page, and the worker in this same process posts it inside the budget.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as rn from "./rednote.js";
import { DATA_DIR, acquireLock, close } from "./session.js";
import { enqueue, listItems, recoverInterrupted, type Args, type Tool } from "./queue.js";
import { BlockedError, appendLedger, haltReason, readLedger, type Limits } from "./ledger.js";
import { startWorker } from "./worker.js";
import { startApproval } from "./approval.js";

const DATA = DATA_DIR;
const QUEUE = join(DATA, "queue");
const LEDGER = join(DATA, "ledger.jsonl");
const SHOTS = join(DATA, "screenshots");
const DRY_RUN = process.env.RN_DRY_RUN !== "0";
/** A typo in a limit must stop the server, never mean "no limit". */
function whole(name: string, fallback: number): number {
  const raw = process.env[name] ?? String(fallback);
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number, 0 or more. Got "${raw}".`);
  return n;
}
const PORT = whole("RN_APPROVAL_PORT", 7317);
const LIMITS: Limits = { daily: whole("RN_DAILY_WRITES", 5), commentGapMin: whole("RN_COMMENT_GAP_MIN", 10) };
const log = (msg: string) => console.error(`[rednote-gate] ${msg}`);

/** A Mac notification. Fixed wording only: never note text or secrets. RN_NOTIFY=0 turns it off. */
function notify(message: string) {
  if (process.env.RN_NOTIFY === "0" || process.platform !== "darwin") return;
  execFile("osascript", ["-e", `display notification ${JSON.stringify(message)} with title "rednote-gate"`], () => {});
}

/** Opens the approval page in the default browser, at most once a minute. The link carries the
 *  token, so it goes to the OS opener, never into a tool result. RN_OPEN_APPROVAL=0 turns it off. */
let lastOpened = 0;
function openApproval(force = false): boolean {
  if (process.env.RN_OPEN_APPROVAL === "0" || (!force && Date.now() - lastOpened < 60_000)) return false;
  let url: string;
  try {
    url = readFileSync(join(DATA, "approval-url"), "utf8").trim();
  } catch {
    return false;
  }
  lastOpened = Date.now();
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  execFile(cmd, args as string[], () => {});
  return true;
}

mkdirSync(QUEUE, { recursive: true });
const lock = acquireLock(DATA);
rn.setGuard(() => {
  const halt = haltReason(readLedger(LEDGER));
  if (halt) throw new Error(`Stopped after RedNote showed: ${halt}. A human must check the account and press Resume on the approval page.`);
});

const text = (data: unknown) => ({ content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });

/** Every browser read goes through here: one owner process, no reads while halted, stop on a block. */
async function read<T>(fn: () => Promise<T>) {
  if (!lock.ok) throw new Error(`Another rednote-gate process (pid ${lock.pid}) owns the browser. Close the other MCP client first.`);
  const halt = haltReason(readLedger(LEDGER));
  if (halt) throw new Error(`Stopped after RedNote showed: ${halt}. A human must check the account and press Resume on the approval page.`);
  try {
    return text(await fn());
  } catch (e) {
    if (e instanceof BlockedError) {
      appendLedger(LEDGER, { at: new Date().toISOString(), event: "blocked", detail: e.message });
      notify("Stopped: RedNote showed a captcha or a warning. Check the account, then press Resume.");
      throw new Error(`${e.message}. Stopped; not retrying. Check the account in the app, then press Resume on the approval page.`);
    }
    throw e;
  }
}

function queue(tool: Tool, args: Args) {
  const { item, duplicate } = enqueue(QUEUE, tool, args);
  const waiting = item.status === "pending";
  const opened = waiting && openApproval();
  const where = opened ? "The approval page has opened in the user's browser." : "The approval page is at `npm run approve` in the rednote-gate folder.";
  if (duplicate) return text(`Already queued as ${item.id} (status: ${item.status}). Not queued again.${waiting ? ` ${where}` : ""}`);
  notify("New item waiting for your approval.");
  return text(
    `Queued as ${item.id}. Nothing has been sent to RedNote. The user must approve it. ${where} ` +
      `Mode: ${DRY_RUN ? "dry run, so approval fills the form but never publishes" : "live"}. Do not say it was posted; check rednote_queue_status later.`,
  );
}

const noteUrl = z.string().url().refine((u) => { try { rn.parseNoteUrl(u); return true; } catch { return false; } }, "Use a note url returned by rednote_search: https://www.xiaohongshu.com/explore/<id>?xsec_token=... (or www.rednote.com)");
// Single-line fields: a line break would be typed as Enter, which can send a comment early.
const oneLine = (max: number) => z.string().trim().min(1).max(max).refine((s) => !/[\r\n]/.test(s), "No line breaks here: Enter could send it early.");
const title = oneLine(100).refine((t) => rn.titleLength(t) <= 20, "Title is longer than RedNote's 20 (a CJK character counts 1, ASCII counts half).");
const post = {
  title,
  body: z.string().min(1).max(1000).describe("note body; line breaks are kept"),
  images: z.array(z.string()).min(1).max(9).describe("absolute paths to JPEG, PNG or WebP files, in posting order; the first is the cover"),
};

const server = new McpServer({ name: "rednote-gate", version: "0.1.0" });

server.registerTool("rednote_login_status", { description: "Check whether the saved RedNote session is logged in (main site and creator site). Read only." }, () => read(() => rn.loginStatus()));
server.registerTool(
  "rednote_search",
  { description: "Search RedNote notes by keyword. Read only. Returns note urls that carry the xsec_token other tools need.", inputSchema: { keyword: z.string().min(1), limit: z.number().int().positive().max(30).optional() } },
  ({ keyword, limit }) => read(() => rn.search(keyword, limit ?? 10)),
);
server.registerTool("rednote_get_note", { description: "Read one note: title, body, author, tags, counts. Read only.", inputSchema: { url: noteUrl } }, ({ url }) => read(() => rn.getNote(url)));
server.registerTool(
  "rednote_get_comments",
  { description: "Read the first page of comments on a note: id, author, text. Read only. Use these values for rednote_reply_comment.", inputSchema: { url: noteUrl, limit: z.number().int().positive().max(50).optional() } },
  ({ url, limit }) => read(() => rn.getComments(url, limit ?? 20)),
);
server.registerTool(
  "rednote_create_post",
  { description: "Queue a photo note for human approval. Does NOT post. Returns a queue id.", inputSchema: post },
  (a) => queue("create_post", a),
);
server.registerTool(
  "rednote_create_draft",
  { description: "Queue a photo note to be saved as a draft, after human approval. Does NOT post. Returns a queue id.", inputSchema: post },
  (a) => queue("create_draft", a),
);
server.registerTool(
  "rednote_post_comment",
  { description: "Queue a comment on a note for human approval. Does NOT post. Returns a queue id.", inputSchema: { url: noteUrl, text: oneLine(500) } },
  ({ url, text: t }) => queue("post_comment", { noteUrl: url, text: t }),
);
server.registerTool(
  "rednote_reply_comment",
  {
    description: "Queue a reply to one comment for human approval. Does NOT post. Pass commentId, commentAuthor and commentText exactly as rednote_get_comments returned them.",
    inputSchema: { url: noteUrl, commentId: z.string().regex(/^[0-9a-zA-Z]{8,32}$/), commentAuthor: z.string().trim().min(1), commentText: z.string().trim().min(1), text: oneLine(500) },
  },
  ({ url, text: t, ...rest }) => queue("reply_comment", { noteUrl: url, ...rest, text: t }),
);
server.registerTool(
  "rednote_open_approval_page",
  { description: "Open the approval page in the user's browser so they can approve or reject queued writes. Returns no link." },
  () => text(openApproval(true) ? "Opened the approval page in the user's browser." : "Could not open it. The user can run `npm run approve` in the rednote-gate folder."),
);
server.registerTool(
  "rednote_queue_status",
  { description: "List recent queued writes and what happened to them. Read only. Never touches the browser.", inputSchema: { limit: z.number().int().positive().max(50).optional() } },
  ({ limit }) =>
    text(
      listItems(QUEUE)
        .reverse()
        .slice(0, limit ?? 10)
        .map((i) => ({ id: i.id, tool: i.tool, status: i.status, lastChange: i.history.at(-1)?.at, note: i.history.at(-1)?.note })),
    ),
);

// ─── Workflows: show up as slash commands in Claude Code ────────────────────────────────────
const say = (t: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text: t } }] });
const RULES =
  "Rules: a title is one line and at most 20 (a CJK character counts 1, ASCII counts half). Comments and replies are one line. " +
  "Queuing never posts: a human approves each item on the approval page, which opens by itself. Never say something was posted; " +
  "check rednote_queue_status if asked. If a tool reports a captcha or a stop, stop and tell the user. Do not retry.";

server.registerPrompt(
  "post_photos",
  {
    title: "Draft a photo note and queue it",
    description: "Write a RedNote photo note from your photos and a short brief, then queue it for your approval.",
    argsSchema: { photos: z.string().describe("absolute paths to the photos, comma separated, cover first"), about: z.string().describe("what the note is about, in a sentence or two") },
  },
  ({ photos, about }) =>
    say(
      `Draft a RedNote photo note about: ${about}\nPhotos, in this order (the first is the cover): ${photos}\n` +
        "Write it the way people write on RedNote: a catchy title, a warm and specific body with short paragraphs, and 3 to 5 relevant hashtags at the end as plain #words. " +
        "Match the language of the brief. Then call rednote_create_post with the photos in the given order. Show the user the title and body you queued. " +
        RULES,
    ),
);
server.registerPrompt(
  "reply_to_comments",
  {
    title: "Draft replies to a note's comments",
    description: "Read the comments on one of your notes, draft replies to the ones worth answering, and queue them for approval.",
    argsSchema: { url: z.string().describe("the note url, from rednote_search or the address bar") },
  },
  ({ url }) =>
    say(
      `Call rednote_get_comments for ${url}. Pick at most 3 comments worth answering: real questions or real feedback. Skip spam, insults and anything you cannot answer honestly. ` +
        "For each, write a short, friendly, specific reply in the commenter's language, under 200 characters. Queue each with rednote_reply_comment, passing commentId, commentAuthor and commentText exactly as returned. " +
        "Replies go out at least 10 minutes apart because of the budget. List what you queued. " +
        RULES,
    ),
);
server.registerPrompt(
  "research_topic",
  {
    title: "Research a topic on RedNote",
    description: "Search a topic, read the top notes and their comments, and summarise what works. Read only.",
    argsSchema: { topic: z.string().describe("keyword or phrase to search") },
  },
  ({ topic }) =>
    say(
      `Research "${topic}" on RedNote. Call rednote_search with limit 10. Read the 3 notes with the most likes using rednote_get_note, and the comments of the top one with rednote_get_comments. ` +
        "Summarise: what people post about it, the questions commenters keep asking, title patterns that get likes, common hashtags, and 3 concrete post ideas for this account. " +
        "This is read only: do not queue anything. Space out the reads; do not call tools in parallel.",
    ),
);
server.registerPrompt(
  "review_queue",
  { title: "What is waiting and what happened", description: "Summarise the approval queue and recent results, and open the approval page." },
  () =>
    say(
      "Call rednote_queue_status with limit 20 and summarise it in plain words: what waits for approval, what ran, and anything failed or unknown that needs a look in the app. " +
        "If anything is waiting, call rednote_open_approval_page.",
    ),
);

async function main() {
  let stopWorker = () => {};
  if (lock.ok) {
    for (const i of recoverInterrupted(QUEUE)) {
      appendLedger(LEDGER, { at: new Date().toISOString(), event: "result", id: i.id, tool: i.tool, outcome: i.status, detail: i.history.at(-1)?.note });
      log(`${i.id} was cut off mid-attempt; marked ${i.status}.`);
    }
    const token = randomBytes(24).toString("hex");
    const { port } = await startApproval({ dir: QUEUE, ledger: LEDGER, shots: SHOTS, token, port: PORT, limits: LIMITS, dryRun: DRY_RUN });
    const urlFile = join(DATA, "approval-url");
    writeFileSync(urlFile, `http://127.0.0.1:${port}/?t=${token}\n`, { mode: 0o600 });
    chmodSync(urlFile, 0o600);
    const SAY: Partial<Record<string, string>> = {
      posted: "Done. It went out. The screenshot is on the approval page.",
      dry_run: "Dry run finished. Nothing was published. The screenshot is on the approval page.",
      failed: "A write stopped before sending. Nothing was posted. Details on the approval page.",
      unknown: "A write may or may not have gone out. Check the RedNote app.",
    };
    const onOutcome = (outcome: string) => {
      if (haltReason(readLedger(LEDGER))) notify("Stopped: RedNote showed a captcha or a warning. Check the account, then press Resume.");
      else if (SAY[outcome]) notify(SAY[outcome]!);
    };
    const run = (item: Parameters<typeof rn.runWrite>[0], shot: string, dry: boolean) => rn.runWrite(item, QUEUE, shot, dry);
    stopWorker = startWorker({ dir: QUEUE, ledger: LEDGER, shots: SHOTS, limits: LIMITS, dryRun: DRY_RUN, idle: rn.browserIdle, run }, 10_000, onOutcome);
    log(`approval page on 127.0.0.1:${port} (run \`npm run approve\` for the link). Mode: ${DRY_RUN ? "dry run" : "LIVE"}.`);
  } else {
    log(`another process (pid ${lock.pid}) owns the browser. This copy can queue writes and show status only.`);
  }
  await server.connect(new StdioServerTransport());
  const shutdown = async () => {
    stopWorker();
    await close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown); // the MCP client went away
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
