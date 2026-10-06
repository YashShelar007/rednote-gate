// MCP stdio server. Reads run directly. Write tools only queue; a human approves each item on
// the localhost page, and the worker in this same process posts it inside the budget.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
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
const PORT = Number(process.env.RN_APPROVAL_PORT || 7317);
const LIMITS: Limits = { daily: Number(process.env.RN_DAILY_WRITES || 5), commentGapMin: Number(process.env.RN_COMMENT_GAP_MIN || 10) };
const log = (msg: string) => console.error(`[rednote-gate] ${msg}`);

mkdirSync(QUEUE, { recursive: true });
const lock = acquireLock(DATA);

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
      throw new Error(`${e.message}. Stopped; not retrying. Check the account in the app, then press Resume on the approval page.`);
    }
    throw e;
  }
}

function queue(tool: Tool, args: Args) {
  const { item, duplicate } = enqueue(QUEUE, tool, args);
  if (duplicate) return text(`Already queued as ${item.id} (status: ${item.status}). Not queued again.`);
  return text(
    `Queued as ${item.id}. Nothing has been sent to RedNote. A human must approve it on the approval page ` +
      `(run \`npm run approve\` in the rednote-gate folder for the link). Mode: ${DRY_RUN ? "dry run, so approval fills the form but never publishes" : "live"}.`,
  );
}

const noteUrl = z.string().url().refine((u) => { try { rn.parseNoteUrl(u); return true; } catch { return false; } }, "Use a note url returned by rednote_search: https://www.xiaohongshu.com/explore/<id>?xsec_token=... (or www.rednote.com)");
const title = z.string().min(1).refine((t) => rn.titleLength(t) <= 20, "Title is longer than RedNote's 20 (a CJK character counts 1, ASCII counts half).");
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
  { description: "Queue a comment on a note for human approval. Does NOT post. Returns a queue id.", inputSchema: { url: noteUrl, text: z.string().min(1).max(500) } },
  ({ url, text: t }) => queue("post_comment", { noteUrl: url, text: t }),
);
server.registerTool(
  "rednote_reply_comment",
  {
    description: "Queue a reply to one comment for human approval. Does NOT post. Pass commentId, commentAuthor and commentText exactly as rednote_get_comments returned them.",
    inputSchema: { url: noteUrl, commentId: z.string().regex(/^[0-9a-zA-Z]{8,32}$/), commentAuthor: z.string(), commentText: z.string().min(1), text: z.string().min(1).max(500) },
  },
  ({ url, text: t, ...rest }) => queue("reply_comment", { noteUrl: url, ...rest, text: t }),
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

async function main() {
  let stopWorker = () => {};
  if (lock.ok) {
    for (const i of recoverInterrupted(QUEUE)) {
      appendLedger(LEDGER, { at: new Date().toISOString(), event: "result", id: i.id, tool: i.tool, outcome: i.status, detail: i.history.at(-1)?.note });
      log(`${i.id} was cut off mid-attempt; marked ${i.status}.`);
    }
    const token = randomBytes(24).toString("hex");
    const { port } = await startApproval({ dir: QUEUE, ledger: LEDGER, token, port: PORT, limits: LIMITS, dryRun: DRY_RUN });
    const urlFile = join(DATA, "approval-url");
    writeFileSync(urlFile, `http://127.0.0.1:${port}/?t=${token}\n`, { mode: 0o600 });
    chmodSync(urlFile, 0o600);
    stopWorker = startWorker({ dir: QUEUE, ledger: LEDGER, shots: SHOTS, limits: LIMITS, dryRun: DRY_RUN, run: (item, shot, dry) => rn.runWrite(item, QUEUE, shot, dry) });
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
