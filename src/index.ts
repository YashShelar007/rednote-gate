// MCP stdio server: a thin layer. Write tools only add files to the queue. Reads go to the
// rednote-gate service (service.ts), which owns the browser, the approval page and the worker,
// and keeps running after this process exits. This process starts the service when needed.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile, spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import * as rn from "./rednote.js";
import { enqueue, listItems, type Args, type Tool } from "./queue.js";
import { THEMES, renderCards } from "./cards.js";
import { DATA, QUEUE, URL_FILE, notify } from "./config.js";

const SERVICE = fileURLToPath(new URL("./service.js", import.meta.url));
mkdirSync(QUEUE, { recursive: true });

const text = (data: unknown) => ({ content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });

type Service = { url: URL; token: string; dryRun: boolean };
async function probe(): Promise<Service | null> {
  try {
    const url = new URL(readFileSync(URL_FILE, "utf8").trim());
    const token = url.searchParams.get("t") ?? "";
    const r = await fetch(new URL(`/health?t=${token}`, url), { signal: AbortSignal.timeout(2_000) });
    return r.ok ? { url, token, dryRun: ((await r.json()) as { dryRun: boolean }).dryRun } : null;
  } catch {
    return null;
  }
}

/** Finds the running service, or starts it detached so it outlives this MCP session. */
let starting: Promise<Service> | null = null;
async function service(): Promise<Service> {
  const up = await probe();
  if (up) return up;
  starting ??= (async () => {
    const out = openSync(join(DATA, "service.log"), "a");
    spawn(process.execPath, [SERVICE], { detached: true, stdio: ["ignore", out, out], env: process.env }).unref();
    for (const end = Date.now() + 20_000; Date.now() < end; ) {
      await new Promise((r) => setTimeout(r, 500));
      const s = await probe();
      if (s) return s;
    }
    throw new Error("Could not start the rednote-gate service. See data/service.log in the rednote-gate folder.");
  })().finally(() => (starting = null));
  return starting;
}

async function read(tool: string, args: object = {}) {
  const s = await service();
  const r = await fetch(new URL("/api/read", s.url), {
    method: "POST",
    headers: { "content-type": "application/json", "x-rednote-gate-token": s.token },
    body: JSON.stringify({ tool, args }),
  });
  const j = (await r.json()) as { ok: boolean; result?: unknown; error?: string };
  if (!j.ok) throw new Error(j.error);
  return text(j.result);
}

/** Opens the approval page in the default browser, at most once a minute. The link carries the
 *  token, so it goes to the OS opener, never into a tool result. RN_OPEN_APPROVAL=0 turns it off. */
let lastOpened = 0;
function openApproval(s: Service, force = false): boolean {
  if (process.env.RN_OPEN_APPROVAL === "0" || (!force && Date.now() - lastOpened < 60_000)) return false;
  lastOpened = Date.now();
  const url = s.url.toString();
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  execFile(cmd, args as string[], () => {});
  return true;
}

async function queue(tool: Tool, args: Args) {
  const { item, duplicate } = enqueue(QUEUE, tool, args);
  const s = await service(); // the page and the worker live there
  const waiting = item.status === "pending";
  const opened = waiting && openApproval(s);
  const where = opened ? "The approval page has opened in the user's browser." : "The user can open the approval page with rednote_open_approval_page.";
  if (duplicate) return text(`Already queued as ${item.id} (status: ${item.status}). Not queued again.${waiting ? ` ${where}` : ""}`);
  notify("New item waiting for your approval.");
  return text(
    `Queued as ${item.id}. Nothing has been sent to RedNote. The user must approve it. ${where} ` +
      `Mode: ${s.dryRun ? "dry run, so approval fills the form but never publishes" : "live"}. Do not say it was posted; check rednote_queue_status later.`,
  );
}

const noteUrl = z.string().url().refine((u) => { try { rn.parseNoteUrl(u); return true; } catch { return false; } }, "Use a note url returned by rednote_search: https://www.xiaohongshu.com/explore/<id>?xsec_token=... (or www.rednote.com)");
// Single-line fields: a line break would be typed as Enter, which can send a comment early.
const oneLine = (max: number) => z.string().trim().min(1).max(max).refine((s) => !/[\r\n]/.test(s), "No line breaks here: Enter could send it early.");
const title = oneLine(100).refine((t) => rn.titleLength(t) <= 20, "Title is longer than RedNote's 20 (a CJK character counts 1, ASCII counts half).");
const topic = z.string().trim().min(1).max(20).refine((t) => !/[#\s]/.test(t), "A topic is one word or phrase, without # or spaces.");
const post = {
  title,
  body: z
    .string()
    .min(1)
    .max(1000)
    .refine((b) => !b.includes("#"), "Put hashtags in topics, not in the body: a # in the body opens RedNote's topic picker and can change the text.")
    .describe("note body; line breaks and emoji are kept; no # here"),
  topics: z.array(topic).max(5).optional().describe("up to 5 topics without #, added as RedNote topics at the end of the body"),
  images: z.array(z.string()).min(1).max(9).describe("absolute paths to JPEG, PNG or WebP files, in posting order; the first is the cover"),
};

const server = new McpServer({ name: "rednote-gate", version: "0.1.0" });

server.registerTool("rednote_login_status", { description: "Check whether the saved RedNote session is logged in (main site and creator site). Read only." }, () => read("login_status"));
server.registerTool(
  "rednote_search",
  { description: "Search RedNote notes by keyword. Read only. Returns note urls that carry the xsec_token other tools need.", inputSchema: { keyword: z.string().min(1), limit: z.number().int().positive().max(30).optional() } },
  ({ keyword, limit }) => read("search", { keyword, limit }),
);
server.registerTool("rednote_get_note", { description: "Read one note: title, body, author, tags, counts. Read only.", inputSchema: { url: noteUrl } }, ({ url }) => read("get_note", { url }));
server.registerTool(
  "rednote_get_comments",
  { description: "Read the first page of comments on a note: id, author, text. Read only. Use these values for rednote_reply_comment.", inputSchema: { url: noteUrl, limit: z.number().int().positive().max(50).optional() } },
  ({ url, limit }) => read("get_comments", { url, limit }),
);
server.registerTool(
  "rednote_my_notes",
  { description: "List the logged-in account's own notes, newest first: noteId, title, likes, url. Read only. Use the url for comments and replies on your own notes.", inputSchema: { limit: z.number().int().positive().max(30).optional() } },
  ({ limit }) => read("my_notes", { limit }),
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
  "rednote_create_video_post",
  {
    description: "Queue a video note for human approval. Does NOT post. One MP4 or MOV, absolute path, up to 500 MB. RedNote processes the video after upload, which can take minutes.",
    inputSchema: { title, body: post.body, video: z.string().describe("absolute path to an MP4 or MOV file"), topics: post.topics },
  },
  (a) => queue("create_video", a),
);
server.registerTool(
  "rednote_like_note",
  {
    description: "Queue a like on a note for human approval. Does NOT like it yet. Likes have their own daily cap (10 by default). Pass noteTitle so the human sees which note.",
    inputSchema: { url: noteUrl, noteTitle: z.string().max(100).optional() },
  },
  ({ url, noteTitle }) => queue("like_note", { noteUrl: url, ...(noteTitle && { noteTitle }) }),
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
  async () => text(openApproval(await service(), true) ? "Opened the approval page in the user's browser." : "Could not open it. The user can run `npm run approve` in the rednote-gate folder."),
);
server.registerTool(
  "rednote_make_cards",
  {
    description:
      "Render text-card images (1080x1440 PNG, RedNote's 3:4) on this computer, for notes without photos. Never touches RedNote. " +
      "Returns absolute paths to pass as images to rednote_create_post. Card 1 is the cover: a short title (use \\n to break a Chinese title where it reads best) and 0 to 2 lines; later cards carry up to 8 short lines.",
    inputSchema: {
      cards: z
        .array(z.object({ title: z.string().min(1).max(40), lines: z.array(z.string().max(60)).max(8).optional(), footer: z.string().max(40).optional() }))
        .min(1)
        .max(9),
      theme: z.enum(THEMES as [string, ...string[]]).optional().describe(`one of: ${THEMES.join(", ")}`),
    },
  },
  async ({ cards, theme }) => text(await renderCards(cards, join(DATA, "cards"), theme)),
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
    argsSchema: { photos: z.string().optional().describe("absolute paths to the photos, comma separated, cover first"), about: z.string().optional().describe("what the note is about, in a sentence or two") },
  },
  ({ photos, about }) =>
    say(
      `${!photos || !about ? "First ask the user for whatever is missing: the photo paths (cover first) and what the note is about. Then continue.\n" : ""}` +
        `Draft a RedNote photo note about: ${about ?? "(ask the user)"}\nPhotos, in this order (the first is the cover): ${photos ?? "(ask the user)"}\n` +
        "Write it the way people write on RedNote: a catchy title and a warm, specific body with short paragraphs; emoji are fine. Put 3 to 5 relevant topics in the topics field (no # in the body). " +
        "Match the language of the brief. Then call rednote_create_post with the photos in the given order. Show the user the title and body you queued. " +
        RULES,
    ),
);
server.registerPrompt(
  "post_from_concept",
  {
    title: "Turn a concept into a post",
    description: "Research a concept on RedNote, write a note about it, make text-card images, and queue it for your approval.",
    argsSchema: { concept: z.string().optional().describe("the idea, topic or angle for the post") },
  },
  ({ concept }) =>
    say(
      `${concept ? "" : "First ask the user what the post should be about. Then continue.\n"}Concept: ${concept ?? "(ask the user)"}\n` +
        "1. Research: rednote_search for the concept (limit 10), then read the 2 or 3 most-liked notes with rednote_get_note. Note what titles, angles and tips get likes. One call at a time.\n" +
        "2. Write an original note (never copy others' text): a catchy title, a useful body with short paragraphs and concrete tips, emoji welcome, and 3 to 5 topics in the topics field. Match the concept's language.\n" +
        "3. Make 3 to 5 cards with rednote_make_cards: card 1 is the cover (the hook as title, one short subtitle line), the rest carry the key points, 3 to 6 short lines each. Pick one theme for the set.\n" +
        "4. Queue it with rednote_create_post using the card paths in order. Show the user the title, body and topics you queued. " +
        RULES,
    ),
);
server.registerPrompt(
  "reply_to_comments",
  {
    title: "Draft replies to a note's comments",
    description: "Read the comments on one of your notes, draft replies to the ones worth answering, and queue them for approval.",
    argsSchema: { url: z.string().optional().describe("the note url, from rednote_search or the address bar") },
  },
  ({ url }) =>
    say(
      `${url ? "" : "First ask the user which note. rednote_my_notes lists their own notes with urls. Then continue.\n"}Call rednote_get_comments for ${url ?? "that note"}. Pick at most 3 comments worth answering: real questions or real feedback. Skip spam, insults and anything you cannot answer honestly. ` +
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
    argsSchema: { topic: z.string().optional().describe("keyword or phrase to search") },
  },
  ({ topic }) =>
    say(
      `${topic ? "" : "First ask the user what topic to research. Then continue.\n"}Research "${topic ?? "the topic"}" on RedNote. Call rednote_search with limit 10. Read the 3 notes with the most likes using rednote_get_note, and the comments of the top one with rednote_get_comments. ` +
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
  await server.connect(new StdioServerTransport());
  process.stdin.on("close", () => process.exit(0)); // the MCP client went away; the service stays up
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
