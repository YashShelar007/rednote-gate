// The queue: one JSON file per pending write, readable by anyone who opens it. Write tools only
// call enqueue(); nothing here touches the browser. Images are copied in and hashed at enqueue
// time, so what a human approves is byte for byte what the worker uploads.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";

export type Tool = "create_post" | "create_draft" | "post_comment" | "reply_comment";
export type Status = "pending" | "approved" | "rejected" | "posting" | "posted" | "dry_run" | "failed" | "unknown";

/** images are paths relative to the queue folder, e.g. "q_20261006T120000_ab12/0.png". */
export type PostArgs = { title: string; body: string; images: string[] };
export type CommentArgs = { noteUrl: string; text: string };
export type ReplyArgs = { noteUrl: string; commentId: string; commentAuthor: string; commentText: string; text: string };
export type Args = PostArgs | CommentArgs | ReplyArgs;

export interface Item {
  id: string;
  tool: Tool;
  args: Args;
  imageSha256?: string[];
  contentHash: string;
  createdAt: string;
  status: Status;
  history: { status: Status; at: string; note?: string }[];
}

const NEXT: Record<Status, Status[]> = {
  pending: ["approved", "rejected"],
  approved: ["posting", "rejected"],
  posting: ["posted", "dry_run", "failed", "unknown"],
  rejected: [],
  posted: [],
  dry_run: [],
  failed: [],
  unknown: [],
};
// A new identical write is refused while one of these exists: it may be posted, or may still post.
const BLOCKS_DUPLICATE: Status[] = ["pending", "approved", "posting", "posted", "unknown"];

const ID = /^q_\d{8}T\d{6}_[0-9a-f]{4}$/;
const MAX_IMAGES = 9; // project limit, not RedNote's
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAGIC: Array<[string, (b: Buffer) => boolean]> = [
  ["jpeg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["png", (b) => b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))],
  ["webp", (b) => b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP"],
];

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

function writeAtomic(path: string, data: string) {
  writeFileSync(`${path}.tmp`, data);
  renameSync(`${path}.tmp`, path);
}

function checkImage(path: string): string {
  if (!isAbsolute(path)) throw new Error(`Image path must be absolute: ${path}`);
  const size = statSync(path).size;
  if (size > MAX_IMAGE_BYTES) throw new Error(`Image over 20 MB: ${path}`);
  const head = Buffer.alloc(12);
  const fd = openSync(path, "r");
  try {
    readSync(fd, head, 0, 12, 0);
  } finally {
    closeSync(fd);
  }
  const kind = MAGIC.find(([, ok]) => ok(head));
  if (!kind) throw new Error(`File is not a JPEG, PNG or WebP: ${path}`);
  return kind[0] === "jpeg" ? ".jpg" : `.${kind[0]}`;
}

export function readItem(dir: string, id: string): Item {
  if (!ID.test(id)) throw new Error(`bad queue id: ${id}`);
  return JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8"));
}

export function listItems(dir: string): Item[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readItem(dir, f.slice(0, -5)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)); // oldest first
}

export function enqueue(dir: string, tool: Tool, args: Args, now = new Date()): { item: Item; duplicate: boolean } {
  mkdirSync(dir, { recursive: true });
  const isPost = tool === "create_post" || tool === "create_draft";
  const sources = isPost ? (args as PostArgs).images : [];
  if (isPost && (sources.length < 1 || sources.length > MAX_IMAGES)) throw new Error(`A photo note needs 1 to ${MAX_IMAGES} images.`);
  const exts = sources.map(checkImage);
  const imageSha256 = sources.map((p) => sha256(readFileSync(p)));
  const contentHash = sha256(JSON.stringify({ tool, args: isPost ? { ...args, images: imageSha256 } : args }));

  const existing = listItems(dir).find((i) => i.contentHash === contentHash && BLOCKS_DUPLICATE.includes(i.status));
  if (existing) return { item: existing, duplicate: true };

  const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, 15);
  const id = `q_${stamp}_${randomBytes(2).toString("hex")}`;
  let stored = args;
  if (isPost) {
    mkdirSync(join(dir, id));
    const images = sources.map((src, n) => {
      copyFileSync(src, join(dir, id, `${n}${exts[n]}`));
      return `${id}/${n}${exts[n]}`;
    });
    stored = { ...(args as PostArgs), images };
  }
  const at = now.toISOString();
  const item: Item = { id, tool, args: stored, ...(isPost && { imageSha256 }), contentHash, createdAt: at, status: "pending", history: [{ status: "pending", at }] };
  writeAtomic(join(dir, `${id}.json`), JSON.stringify(item, null, 2));
  return { item, duplicate: false };
}

export function transition(dir: string, id: string, to: Status, note?: string, now = new Date()): Item {
  const item = readItem(dir, id);
  if (!NEXT[item.status].includes(to)) throw new Error(`Not allowed: ${item.status} -> ${to} (${id})`);
  item.status = to;
  item.history.push({ status: to, at: now.toISOString(), ...(note && { note }) });
  writeAtomic(join(dir, `${id}.json`), JSON.stringify(item, null, 2));
  return item;
}

/** On startup: anything still "posting" was cut off mid-attempt. A live one becomes unknown and is
 *  never retried. A dry run never clicks the final button, so it simply failed. */
export function recoverInterrupted(dir: string, now = new Date()): Item[] {
  return listItems(dir)
    .filter((i) => i.status === "posting")
    .map((i) =>
      i.history.at(-1)?.note === "dry run"
        ? transition(dir, i.id, "failed", "process stopped mid dry run", now)
        : transition(dir, i.id, "unknown", "process stopped mid-attempt; check the account by hand", now),
    );
}
