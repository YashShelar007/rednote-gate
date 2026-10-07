// What rednote-gate can do, in one place, for the rednote_help tool and the help prompt.
// help.test.ts keeps this list identical to what index.ts registers.
import { budgetCheck, type Entry as LedgerEntry, type Limits } from "./ledger.js";

type Entry = { name: string; what: string };
export const CATALOGUE = {
  tools: [
    { name: "rednote_login_status", kind: "read", what: "is the saved session logged in (main and creator site)" },
    { name: "rednote_search", kind: "read", what: "search notes by keyword; returns links the other tools accept" },
    { name: "rednote_get_note", kind: "read", what: "read one note: title, body, topics, counts" },
    { name: "rednote_get_comments", kind: "read", what: "read the first page of comments on a note" },
    { name: "rednote_my_notes", kind: "read", what: "list your own notes, newest first" },
    { name: "rednote_create_post", kind: "write", what: "photo note: title, body, 1 to 9 images, up to 5 linked topics" },
    { name: "rednote_create_video_post", kind: "write", what: "video note from one MP4 or MOV" },
    { name: "rednote_create_draft", kind: "write", what: "save a photo note as a draft (stays in rednote-gate's browser)" },
    { name: "rednote_post_comment", kind: "write", what: "comment on any note" },
    { name: "rednote_reply_comment", kind: "write", what: "reply to one comment, only if its author and text still match" },
    { name: "rednote_like_note", kind: "write", what: "like a note (its own daily cap)" },
    { name: "rednote_make_cards", kind: "local", what: "render text-card images for notes without photos" },
    { name: "rednote_queue_status", kind: "local", what: "what is waiting and what happened" },
    { name: "rednote_open_approval_page", kind: "local", what: "open the approval page in your browser" },
    { name: "rednote_help", kind: "local", what: "this overview" },
  ],
  prompts: [
    { name: "post_from_concept", what: "research a concept, write an original note, make cards, queue it" },
    { name: "post_photos", what: "write a note around your photos and queue it" },
    { name: "reply_to_comments", what: "draft replies to the comments worth answering on a note" },
    { name: "research_topic", what: "what works for a topic, plus 3 post ideas (read only)" },
    { name: "review_queue", what: "summarise the queue and open the approval page" },
    { name: "help", what: "this overview" },
  ] as Entry[],
};

export type HelpStatus = {
  version: string;
  site: string;
  dryRun: boolean;
  writesUsed: number;
  likesUsed: number;
  limits: Limits;
  nextWrite?: string; // when the next write slot opens, if the daily writes are used up
};

/** Live writes and likes in the last 24 hours, and when the next write opens if none is left. */
export function usage(entries: LedgerEntry[], limits: Limits, now: Date): Pick<HelpStatus, "writesUsed" | "likesUsed" | "nextWrite"> {
  const live24 = entries.filter((e) => e.event === "attempt" && e.dryRun === false && now.getTime() - Date.parse(e.at) < 24 * 3600_000);
  const writesUsed = live24.filter((e) => e.tool !== "like_note").length;
  const slot = budgetCheck(entries, "create_post", now, limits);
  const nextWrite = !slot.ok && Number.isFinite(slot.retryAt.getTime()) ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(slot.retryAt) : undefined;
  return { writesUsed, likesUsed: live24.length - writesUsed, nextWrite };
}

/** Version, site, mode and today's budget: the top of rednote_help and `rednote-gate status`. */
export function statusLines(s: HelpStatus): string[] {
  const likeCap = s.limits.likes ?? 10;
  return [
    `rednote-gate ${s.version} on ${s.site}. Mode: ${s.dryRun ? "DRY RUN (approved items fill the form but never publish)" : "LIVE (approved items are published)"}.`,
    `Today: ${Math.max(0, s.limits.daily - s.writesUsed)} of ${s.limits.daily} writes left${s.nextWrite ? ` (next at ${s.nextWrite})` : ""}, ` +
      `${Math.max(0, likeCap - s.likesUsed)} of ${likeCap} likes left, comments and replies at least ${s.limits.commentGapMin} minutes apart.`,
  ];
}

export function helpText(s: HelpStatus): string {
  const list = (kind: string) =>
    CATALOGUE.tools
      .filter((t) => t.kind === kind)
      .map((t) => `- ${t.name}: ${t.what}`)
      .join("\n");
  return [
    ...statusLines(s),
    "",
    "Read, runs straight away:",
    list("read"),
    "",
    "Write, waits for your Approve click on the approval page:",
    list("write"),
    "",
    "On this computer only, never touches RedNote:",
    list("local"),
    "",
    "Prompts (slash commands in Claude Code: /rednote-gate:<name>):",
    CATALOGUE.prompts.map((p) => `- ${p.name}: ${p.what}`).join("\n"),
    "",
    "Try asking:",
    '- "Research 期末周自习 on RedNote and give me 3 post ideas."',
    '- "Turn the concept 宿舍收纳 into a post."',
    '- "Post these photos about my weekend hike: /path/a.jpg, /path/b.jpg"',
    '- "Show my notes and reply to the comments on my newest one."',
    "",
    "Rules: nothing is sent without your click; you have 30 seconds to cancel after approving; a captcha or warning stops everything until you press Resume; one throwaway account only.",
  ].join("\n");
}
