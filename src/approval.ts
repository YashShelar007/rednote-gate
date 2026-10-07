// The approval page: one HTML page on 127.0.0.1. A human sees the exact text and images of each
// queued write and clicks Approve or Reject. Approve only marks the item; the worker posts it.
// Defences: Host check (DNS rebinding), a secret token on every request, POST-only changes that
// must come from this page's own origin (CSRF), no framing, strict CSP, no referrer.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { listItems, readItem, transition, type Item, type PostArgs, type CommentArgs, type LikeArgs, type ReplyArgs, type Status, type VideoArgs } from "./queue.js";
import { appendLedger, budgetCheck, haltReason, readLedger, type Limits } from "./ledger.js";
import { MAX, loadSettings, saveSettings } from "./settings.js";

export interface ApprovalOptions {
  dir: string;
  ledger: string;
  token: string;
  shots?: string; // screenshots folder, shown on the page after each attempt
  port: number; // 0 picks a free port (tests)
  limits: Limits;
  dryRun: boolean;
  /** When set, the dashboard shows a settings form that writes this file. */
  settingsFile?: string;
  /** Read tools the MCP server calls over 127.0.0.1 with the token in a header. */
  reads?: Record<string, (args: never) => Promise<unknown>>;
}

const ACTIONS: Record<string, { from: Status; to: Status }> = {
  approve: { from: "pending", to: "approved" },
  reject: { from: "pending", to: "rejected" },
  cancel: { from: "approved", to: "rejected" },
};
const TYPES: Record<string, string> = { ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".mp4": "video/mp4", ".mov": "video/quicktime" };
const HEADERS = {
  "Content-Security-Policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  // same-origin, not no-referrer: with no-referrer Chrome sends "Origin: null" on this page's own forms.
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

const ENTITY: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ENTITY[c]);

function sameToken(given: string | null, token: string): boolean {
  const a = Buffer.from(given ?? "");
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 10_000) req.destroy(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const KIND: Record<Item["tool"], string> = { create_post: "Photo note", create_draft: "Draft", create_video: "Video note", post_comment: "Comment", reply_comment: "Reply", like_note: "Like" };
const APPROVE_LIVE: Record<Item["tool"], string> = {
  create_post: "Approve and publish",
  create_draft: "Approve and save draft",
  create_video: "Approve and publish video",
  post_comment: "Approve and send",
  reply_comment: "Approve and send reply",
  like_note: "Approve and like",
};
const STATUS: Record<Status, string> = {
  pending: "Waiting for you",
  approved: "Approved",
  rejected: "Rejected",
  posting: "Running now",
  posted: "Done",
  dry_run: "Dry run done",
  failed: "Failed, nothing sent",
  unknown: "Unknown, check the app",
};
const when = (iso: string) => {
  const label = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  return `<time datetime="${esc(iso)}">${esc(label)}</time>`;
};

function content(item: Item, t: string): string {
  if (item.tool === "create_post" || item.tool === "create_draft") {
    const a = item.args as PostArgs;
    const imgs = a.images
      .map((_, n) => `<li><img src="/img/${item.id}/${n}?t=${t}" width=144 height=144 alt="Image ${n + 1}${n === 0 ? ", cover" : ""}" loading=lazy><span>${n === 0 ? "1, cover" : n + 1}</span></li>`)
      .join("");
    const topics = a.topics?.length ? `<dt>Topics</dt><dd>${a.topics.map((t) => `#${esc(t)}`).join(" ")}</dd>` : "";
    return `<dl><dt>Title</dt><dd class=title>${esc(a.title)}</dd><dt>Body</dt><dd class=text>${esc(a.body)}</dd>${topics}<dt>Images, in posting order</dt><dd><ol class=imgs>${imgs}</ol></dd></dl>`;
  }
  if (item.tool === "create_video") {
    const a = item.args as VideoArgs;
    const topics = a.topics?.length ? `<dt>Topics</dt><dd>${a.topics.map((t) => `#${esc(t)}`).join(" ")}</dd>` : "";
    return `<dl><dt>Title</dt><dd class=title>${esc(a.title)}</dd><dt>Body</dt><dd class=text>${esc(a.body)}</dd>${topics}<dt>Video</dt><dd><video class=shot controls preload=metadata src="/media/${item.id}?t=${t}"></video></dd></dl>`;
  }
  if (item.tool === "like_note") {
    const a = item.args as LikeArgs;
    return `<dl><dt>Like this note</dt><dd>${a.noteTitle ? `<span class=title>${esc(a.noteTitle)}</span><br>` : ""}<a href="${esc(a.noteUrl)}" rel="noreferrer noopener" target="_blank" translate=no>${esc(a.noteUrl)}</a></dd></dl>`;
  }
  const a = item.args as CommentArgs & Partial<ReplyArgs>;
  const note = `<dt>On note</dt><dd><a href="${esc(a.noteUrl)}" rel="noreferrer noopener" target="_blank" translate=no>${esc(a.noteUrl)}</a></dd>`;
  const target = item.tool === "reply_comment" ? `<dt>Replying to ${esc(a.commentAuthor)}</dt><dd class="text quote">${esc(a.commentText)}</dd>` : "";
  return `<dl>${note}${target}<dt>${item.tool === "reply_comment" ? "Your reply" : "Your comment"}</dt><dd class=text>${esc(a.text)}</dd></dl>`;
}

function card(item: Item, t: string, mode: string, buttons: Array<[action: string, label: string]>, note = "", shot = false): string {
  const forms = buttons
    .map(([action, label]) => `<form method=post action="/decide"><input type=hidden name=t value="${t}"><input type=hidden name=id value="${item.id}"><input type=hidden name=mode value="${mode}"><button name=action value="${action}" class="${action}" aria-label="${esc(label)}: ${esc(KIND[item.tool])} ${esc(item.id)}">${esc(label)}</button></form>`)
    .join("");
  const last = item.history.at(-1)?.note;
  return `<article aria-labelledby="h-${item.id}"><header><h3 id="h-${item.id}">${KIND[item.tool]}</h3><span class="s ${item.status}">${STATUS[item.status]}</span></header>
<p class=meta>Queued ${when(item.createdAt)}. <code translate=no>${esc(item.id)}</code></p>${content(item, t)}${last ? `<p class=note>${esc(last)}</p>` : ""}${note ? `<p class=note>${esc(note)}</p>` : ""}${shot ? `<p class=note>What the browser showed at the end:</p><a href="/shot/${item.id}?t=${t}" target="_blank"><img class=shot src="/shot/${item.id}?t=${t}" width=640 height=450 alt="Screenshot of the attempt" loading=lazy></a>` : ""}${forms ? `<div class=row>${forms}</div>` : ""}</article>`;
}

const CSS = `:root{color-scheme:light dark;--page:#eef1f4;--surface:#fff;--ink:#1c2024;--muted:#5b636e;--line:#d9dde3;--go:#17703a;--stop:#a61b1b;--wait:#8a5a00;--focus:#1f5fbf;--on-go:#fff}
@media (prefers-color-scheme:dark){:root{--page:#15181c;--surface:#1e2227;--ink:#e6e9ed;--muted:#a3acb7;--line:#343a42;--go:#3fb76a;--stop:#f06a6a;--wait:#e0a43a;--focus:#7fb0ff;--on-go:#0b1f12}}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);font:15px/1.6 system-ui,-apple-system,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif}
main{max-width:44rem;margin:0 auto;padding:1rem}h1{font-size:1.375rem;margin:.5rem 0 1rem;text-wrap:balance}h2{font-size:1rem;margin:2rem 0 .5rem}h3{font-size:.9375rem;margin:0}
.skip{position:absolute;left:-999px}.skip:focus{left:1rem;top:1rem;background:var(--surface);padding:.5rem}
.mode{padding:.75rem 1rem;border-radius:6px;border:2px solid var(--line);background:var(--surface)}.mode.live{border-color:var(--stop)}.mode b{font-size:1.125rem}
.budget{color:var(--muted);font-variant-numeric:tabular-nums}.halt{border:2px solid var(--stop);background:var(--surface);padding:.75rem 1rem;border-radius:6px;margin:1rem 0}
article{background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:.75rem 1rem;margin:.75rem 0}article header{display:flex;justify-content:space-between;gap:.75rem;align-items:baseline}
.meta,.note{color:var(--muted);font-size:.8125rem;margin:.25rem 0}.note{margin-top:.5rem}code{font-size:.75rem}
dl{margin:.5rem 0 0}dt{color:var(--muted);font-size:.8125rem;margin-top:.5rem}dd{margin:0}.title{font-weight:600}.text{white-space:pre-wrap;overflow-wrap:anywhere}.quote{border-left:3px solid var(--line);padding-left:.5rem;color:var(--muted)}a{color:var(--focus);overflow-wrap:anywhere}
.imgs{list-style:none;display:flex;flex-wrap:wrap;gap:.5rem;padding:0;margin:.25rem 0 0}.imgs li{display:flex;flex-direction:column;font-size:.75rem;color:var(--muted)}.imgs img{width:9rem;height:9rem;object-fit:cover;border-radius:4px;border:1px solid var(--line)}
.row{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.75rem}button{font:inherit;font-weight:600;min-height:2.75rem;padding:0 1rem;border-radius:4px;border:1px solid var(--muted);background:var(--surface);color:var(--ink);cursor:pointer;touch-action:manipulation}
button:hover{background:var(--page)}.approve{background:var(--go);border-color:var(--go);color:var(--on-go)}.approve:hover{filter:brightness(1.1);background:var(--go)}.reject,.cancel{color:var(--stop);border-color:var(--stop)}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px}.s{font-size:.8125rem;white-space:nowrap}.s.posted,.s.dry_run{color:var(--go)}.s.unknown,.s.failed{color:var(--stop)}.s.pending,.s.approved{color:var(--wait)}
details summary{cursor:pointer;font-weight:600;margin-top:2rem}
nav{display:flex;gap:1rem;margin:.25rem 0 1rem}nav a{font-weight:600}nav a[aria-current=page]{color:var(--ink);text-decoration:none}
.meters{display:grid;grid-template-columns:auto 1fr auto;gap:.25rem .75rem;align-items:center;margin:.5rem 0 0;font-variant-numeric:tabular-nums}meter{width:100%;height:.75rem}
fieldset{border:1px solid var(--line);border-radius:6px;background:var(--surface);margin:0 0 1rem;padding:.75rem 1rem}legend{font-weight:600;padding:0 .25rem}
.field{display:grid;gap:.25rem;margin:.5rem 0}.choice{display:flex;gap:.5rem;align-items:flex-start;margin:.4rem 0}.choice input{margin-top:.3rem}
input[type=number]{font:inherit;width:7rem;min-height:2.75rem;padding:0 .5rem;border:1px solid var(--muted);border-radius:4px;background:var(--surface);color:var(--ink)}
.msg{padding:.6rem 1rem;border-radius:6px;border:1px solid var(--line);background:var(--surface);margin:0 0 1rem}.msg.err{border-color:var(--stop);color:var(--stop)}.msg.ok{border-color:var(--go)}.shot{width:100%;height:auto;margin-top:.25rem;border:1px solid var(--line);border-radius:4px}`;

const HEAD = (title: string, refresh: boolean) =>
  `<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><meta name=color-scheme content="light dark"><meta name=theme-color content="#eef1f4" media="(prefers-color-scheme: light)"><meta name=theme-color content="#15181c" media="(prefers-color-scheme: dark)">${refresh ? "<meta http-equiv=refresh content=5>" : ""}<title>${title}, rednote-gate</title><style>${CSS}</style></head>`;

function nav(o: ApprovalOptions, here: "queue" | "settings"): string {
  if (!o.settingsFile) return "";
  const link = (href: string, label: string, id: string) => `<a href="${href}?t=${o.token}"${here === id ? " aria-current=page" : ""}>${label}</a>`;
  return `<nav aria-label="Pages">${link("/", "Queue and activity", "queue")}${link("/settings", "Settings", "settings")}</nav>`;
}

function settingsPage(o: ApprovalOptions, q: URLSearchParams): string {
  const t = o.token;
  const s = loadSettings(o.settingsFile!);
  const msg = q.get("error") ? `<p class="msg err" role=alert>${esc(q.get("error"))}</p>` : q.get("saved") ? `<p class="msg ok" role=status>Saved. It applies to the next item that runs.</p>` : "";
  const on = (b: boolean) => (b ? " checked" : "");
  const num = (name: string, label: string, value: number, min: number, max: number, hint: string) =>
    `<label class=field><span>${label}</span><input type=number name="${name}" min="${min}" max="${max}" value="${value}" required inputmode=numeric><span class=note>${hint}</span></label>`;
  return `${HEAD("Settings", false)}
<body><main>
<h1>rednote-gate</h1>${nav(o, "settings")}
${msg}<form method=post action="/settings"><input type=hidden name=t value="${t}">
<fieldset><legend>Mode</legend>
<label class=choice><input type=radio name=mode value=dry${on(s.dryRun)}><span><b>Dry run.</b> Approved items fill in the form on RedNote but are never published or sent.</span></label>
<label class=choice><input type=radio name=mode value=live${on(!s.dryRun)}><span><b>Live.</b> Approved items are published or sent from the account.</span></label>
${s.dryRun ? `<label class=choice><input type=checkbox name=confirmLive><span>I understand that switching to live publishes approved items from my account.</span></label>` : ""}
<p class=note>Approvals only run in the mode they were given in, so switching never sends anything you approved for a dry run.</p>
</fieldset>
<fieldset><legend>Daily limits</legend>
${num("daily", "Writes per day", s.daily, 0, MAX.daily, `Posts, drafts, videos, comments and replies. Up to ${MAX.daily}.`)}
${num("likes", "Likes per day", s.likes, 0, MAX.likes, `Up to ${MAX.likes}.`)}
${num("commentGapMin", "Minutes between comments and replies", s.commentGapMin, MAX.minCommentGapMin, MAX.maxCommentGapMin, `At least ${MAX.minCommentGapMin}.`)}
<p class=note>A new account is safest with the defaults: 5 writes, 10 likes, 10 minutes. The maximums cannot be raised.</p>
</fieldset>
<fieldset><legend>Notifications</legend>
<label class=choice><input type=checkbox name=notify${on(s.notify)}><span>Mac notifications when something is queued, done or stopped</span></label>
<label class=choice><input type=checkbox name=openApproval${on(s.openApproval)}><span>Open this page when something is queued</span></label>
</fieldset>
<div class=row><button class=approve>Save settings</button></div>
</form>
</main></body></html>`;
}

function page(o: ApprovalOptions): string {
  const t = o.token;
  const dry = o.dryRun; // read once: the banner, the buttons and the forms must agree
  const mode = dry ? "dry_run" : "live";
  const items = listItems(o.dir);
  const entries = readLedger(o.ledger);
  const now = new Date();
  const live24 = entries.filter((e) => e.event === "attempt" && e.dryRun === false && new Date(e.at).getTime() > now.getTime() - 24 * 3600_000);
  const used = live24.filter((e) => e.tool !== "like_note").length;
  const likesUsed = live24.length - used;
  const halt = haltReason(entries);
  const waiting = (i: Item) => {
    if (i.approvedFor !== mode) {
      const was = i.approvedFor === "live" ? "a live run" : "a dry run";
      return `Approved for ${was}, but the server now runs ${dry ? "dry" : "live"}. It will not run. Cancel it and approve again.`;
    }
    if (dry) return "Runs about 30 seconds after approval. Dry runs spend no budget.";
    const b = budgetCheck(entries, i.tool, now, o.limits);
    if (b.ok) return "Runs about 30 seconds after approval.";
    if (!Number.isFinite(b.retryAt.getTime())) return `Will not run: ${b.reason}.`;
    const at = new Intl.DateTimeFormat(undefined, { timeStyle: "short", dateStyle: "medium" }).format(b.retryAt);
    const why = b.reason.startsWith("one comment") ? "Comments and replies go out at least 10 minutes apart." : `The ${b.reason.replace(" reached", "")} is reached.`;
    return `Sends automatically at ${at}. ${why}`;
  };
  const approveLabel = (i: Item) => (dry ? "Approve dry run" : APPROVE_LIVE[i.tool]);
  const pending = items.filter((i) => i.status === "pending").map((i) => card(i, t, mode, [["approve", approveLabel(i)], ["reject", "Reject"]]));
  const approved = items.filter((i) => i.status === "approved").map((i) => card(i, t, mode, [["cancel", "Cancel before it runs"]], waiting(i)));
  const hasShot = (i: Item) => !!o.shots && existsSync(join(o.shots, `${i.id}.png`));
  const history = items.filter((i) => !["pending", "approved"].includes(i.status)).reverse().slice(0, 20).map((i) => card(i, t, mode, [], "", hasShot(i)));
  const busy = items.some((i) => i.status === "approved" || i.status === "posting");
  const likeCap = o.limits.likes ?? 10;
  const slot = budgetCheck(entries, "create_post", now, o.limits);
  const next = !slot.ok && Number.isFinite(slot.retryAt.getTime()) ? ` Next write slot ${new Intl.DateTimeFormat(undefined, { timeStyle: "short", dateStyle: "medium" }).format(slot.retryAt)}.` : "";
  return `${HEAD("Approvals", busy)}
<body><a class=skip href="#queue">Skip to the queue</a><main>
<h1>Approve writes to RedNote</h1>${nav(o, "queue")}
<div class="mode ${dry ? "dry" : "live"}">${dry ? "<b>Dry run.</b> Approved items fill in the form on RedNote but are never published or sent." : "<b>Live.</b> Approved items are published or sent from the account about 30 seconds after you approve."}
<div class=meters><span>Writes</span><meter min=0 max="${o.limits.daily}" value="${used}" aria-label="Writes used in the last 24 hours"></meter><span>${used} of ${o.limits.daily}</span><span>Likes</span><meter min=0 max="${likeCap}" value="${likesUsed}" aria-label="Likes used in the last 24 hours"></meter><span>${likesUsed} of ${likeCap}</span></div>
<p class=budget>Live writes and likes in the last 24 hours.${next} <a href="/?t=${t}">Refresh</a></p></div>
${halt ? `<div class=halt role=alert><b>Stopped.</b> RedNote showed: ${esc(halt)}. Nothing runs until you resume. Open the RedNote app and check the account first.<form method=post action="/resume"><input type=hidden name=t value="${t}"><div class=row><button class=approve>Resume</button></div></form></div>` : ""}
<section id=queue aria-labelledby=h-pending><h2 id=h-pending>Needs your decision (${pending.length})</h2>${pending.join("") || "<p class=note>Nothing waiting. When Claude queues a post, comment or reply, it shows up here.</p>"}</section>
<section aria-labelledby=h-approved><h2 id=h-approved>Approved, not run yet (${approved.length})</h2>${approved.join("") || "<p class=note>None.</p>"}</section>
<details${busy || history.length ? " open" : ""}><summary>Recent activity (${history.length})</summary>${history.join("") || "<p class=note>Nothing has run yet.</p>"}</details>
</main></body></html>`;
}

async function handle(o: ApprovalOptions, port: number, req: IncomingMessage, res: ServerResponse) {
  const send = (status: number, body: string | Buffer = "", type = "text/plain; charset=utf-8", extra: Record<string, string> = {}) => {
    res.writeHead(status, { ...HEADERS, "Content-Type": type, ...extra });
    res.end(body);
  };
  const host = req.headers.host ?? "";
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(403, "Bad Host header.");
  const url = new URL(req.url ?? "/", `http://${host}`);

  if (req.method === "GET") {
    if (!sameToken(url.searchParams.get("t"), o.token)) return send(403, "Missing or wrong token. Run `npm run approve` for the link.");
    if (url.pathname === "/") return send(200, page(o), "text/html; charset=utf-8");
    if (url.pathname === "/settings" && o.settingsFile) return send(200, settingsPage(o, url.searchParams), "text/html; charset=utf-8");
    if (url.pathname === "/health") return send(200, JSON.stringify({ ok: true, dryRun: o.dryRun }), "application/json");
    const shot = url.pathname.match(/^\/shot\/([^/]+)$/);
    if (shot && o.shots) {
      try {
        readItem(o.dir, shot[1]); // validates the id
        return send(200, readFileSync(join(o.shots, `${shot[1]}.png`)), "image/png");
      } catch {
        return send(404, "Not found.");
      }
    }
    const media = url.pathname.match(/^\/media\/([^/]+)$/);
    if (media) {
      try {
        const rel = (readItem(o.dir, media[1]).args as VideoArgs).video;
        if (rel) return send(200, readFileSync(join(o.dir, rel)), TYPES[extname(rel)] ?? "application/octet-stream");
      } catch {
        // bad id or missing file: fall through to 404
      }
      return send(404, "Not found.");
    }
    const m = url.pathname.match(/^\/img\/([^/]+)\/(\d+)$/);
    if (m) {
      try {
        const rel = (readItem(o.dir, m[1]).args as PostArgs).images?.[Number(m[2])];
        if (rel) return send(200, readFileSync(join(o.dir, rel)), TYPES[extname(rel)] ?? "application/octet-stream");
      } catch {
        // bad id or missing file: fall through to 404
      }
    }
    return send(404, "Not found.");
  }

  if (req.method !== "POST") return send(405, "Method not allowed.");

  // The read API is for the MCP server, never for a web page: browsers always send Origin on a
  // POST, and the custom token header forces a CORS preflight that this server never approves.
  if (url.pathname === "/api/read") {
    if (req.headers.origin || !sameToken(String(req.headers["x-rednote-gate-token"] ?? ""), o.token)) return send(403, "Forbidden.");
    const { tool, args } = JSON.parse(await readBody(req)) as { tool: string; args: never };
    const fn = Object.hasOwn(o.reads ?? {}, tool) ? o.reads![tool] : undefined;
    const json = (body: unknown) => send(200, JSON.stringify(body), "application/json");
    if (!fn) return json({ ok: false, error: `No read tool called ${tool}.` });
    try {
      return json({ ok: true, result: await fn(args ?? ({} as never)) });
    } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Same-origin only. Browsers that send "Origin: null" still mark their own requests same-origin.
  const sameOrigin = req.headers.origin === `http://${host}` || req.headers["sec-fetch-site"] === "same-origin";
  if (!sameOrigin) return send(403, "Cross-origin request refused.");
  const form = new URLSearchParams(await readBody(req));
  if (!sameToken(form.get("t"), o.token)) return send(403, "Missing or wrong token.");
  const back = { Location: `/?t=${o.token}` };
  if (url.pathname === "/settings" && o.settingsFile) {
    const go = (q: string) => send(303, "", undefined, { Location: `/settings?t=${o.token}&${q}` });
    const num = (k: string) => (form.get(k) ? Number(form.get(k)) : undefined);
    const patch = { daily: num("daily"), likes: num("likes"), commentGapMin: num("commentGapMin"), dryRun: form.get("mode") !== "live", notify: form.has("notify"), openApproval: form.has("openApproval") };
    if (loadSettings(o.settingsFile).dryRun && !patch.dryRun && !form.has("confirmLive")) return go(`error=${encodeURIComponent("Tick the box to confirm switching to live.")}`);
    try {
      saveSettings(o.settingsFile, patch);
    } catch (e) {
      return go(`error=${encodeURIComponent(e instanceof Error ? e.message : String(e))}`);
    }
    return go("saved=1");
  }
  if (url.pathname === "/resume") {
    appendLedger(o.ledger, { at: new Date().toISOString(), event: "resumed", detail: "resumed from the approval page" });
    return send(303, "", undefined, back);
  }
  if (url.pathname === "/decide") {
    const action = ACTIONS[form.get("action") ?? ""];
    const id = form.get("id") ?? "";
    const mode = o.dryRun ? "dry_run" : "live";
    try {
      if (!action || readItem(o.dir, id).status !== action.from) return send(409, "That item is no longer in a state where this button applies. Refresh.");
      const approving = action.to === "approved";
      // An Approve click counts only for the mode its page showed: the mode may have changed since.
      if (approving && form.get("mode") !== mode) return send(409, "The mode changed since this page loaded. Refresh and check before approving.");
      const note = approving ? (mode === "dry_run" ? "approved for a dry run" : "approved to run live") : `${form.get("action")} on the approval page`;
      transition(o.dir, id, action.to, note, new Date(), approving ? { approvedFor: mode } : {});
    } catch {
      return send(400, "Bad request.");
    }
    return send(303, "", undefined, back);
  }
  return send(404, "Not found.");
}

export function startApproval(o: ApprovalOptions): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    let port = o.port;
    const server = createServer((req, res) => {
      handle(o, port, req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500, HEADERS);
        res.end("Internal error.");
      });
    });
    server.on("error", reject);
    server.listen(o.port, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      resolve({ server, port });
    });
  });
}
