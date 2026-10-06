// MCP stdio server entry point. Registers the RedNote tools and wires them to the automation
// layer in rednote.ts. Your MCP client (Claude Code / Codex / Claude Desktop) launches this.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as rn from "./rednote.js";
import { close } from "./session.js";

const server = new McpServer({ name: "rednote-mcp", version: "0.1.0" });

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

server.tool(
  "rednote_login_status",
  "Check whether the saved RedNote session is still logged in.",
  {},
  async () => ok(await rn.loginStatus()),
);

server.tool(
  "rednote_search",
  "Search RedNote (Xiaohongshu) for notes by keyword. Read-only.",
  {
    keyword: z.string().describe("search text"),
    limit: z.number().int().positive().max(30).optional(),
  },
  async ({ keyword, limit }) => ok(await rn.search(keyword, limit ?? 10)),
);

server.tool(
  "rednote_get_note",
  "Fetch a single note's title and body by URL. Read-only.",
  { url: z.string().url() },
  async ({ url }) => ok(await rn.getNote(url)),
);

server.tool(
  "rednote_get_comments",
  "Fetch comments on a note by URL. Read-only.",
  {
    url: z.string().url(),
    limit: z.number().int().positive().max(100).optional(),
  },
  async ({ url, limit }) => ok(await rn.getComments(url, limit ?? 20)),
);

server.tool(
  "rednote_create_post",
  "Publish a photo note (title + body + at least one image path). WRITE. Honors RN_DRY_RUN.",
  {
    title: z.string(),
    body: z.string(),
    images: z
      .array(z.string())
      .min(1)
      .describe("absolute local image file paths"),
  },
  async (a) => ok(await rn.createPost(a)),
);

server.tool(
  "rednote_create_draft",
  "Same as create_post but saves as a draft instead of publishing. WRITE. Honors RN_DRY_RUN.",
  { title: z.string(), body: z.string(), images: z.array(z.string()).min(1) },
  async (a) => ok(await rn.createDraft(a)),
);

server.tool(
  "rednote_post_comment",
  "Post a comment on a note. WRITE. Honors RN_DRY_RUN.",
  { url: z.string().url(), text: z.string() },
  async ({ url, text }) => ok(await rn.postComment(url, text)),
);

server.tool(
  "rednote_reply_comment",
  "Reply to the Nth comment (0-indexed) on a note. WRITE. Honors RN_DRY_RUN.",
  {
    url: z.string().url(),
    commentIndex: z.number().int().min(0),
    text: z.string(),
  },
  async ({ url, commentIndex, text }) =>
    ok(await rn.replyComment(url, commentIndex, text)),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const shutdown = async () => {
    await close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
