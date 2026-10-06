// The approval page: one HTML page on 127.0.0.1. A human sees the exact text and images of each
// queued write and clicks Approve or Reject. Approve only marks the item; the worker posts it.
// Defences: Host check (DNS rebinding), a secret token on every request, POST-only changes that
// must come from this page's own origin (CSRF), no framing, strict CSP, no referrer.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { listItems, readItem, transition, type Item, type PostArgs, type CommentArgs, type ReplyArgs, type Status } from "./queue.js";
import { appendLedger, budgetCheck, haltReason, readLedger, type Limits } from "./ledger.js";

export interface ApprovalOptions {
  dir: string;
  ledger: string;
  token: string;
  port: number; // 0 picks a free port (tests)
  limits: Limits;
  dryRun: boolean;
}

const ACTIONS: Record<string, { from: Status; to: Status }> = {
  approve: { from: "pending", to: "approved" },
  reject: { from: "pending", to: "rejected" },
  cancel: { from: "approved", to: "rejected" },
};
const TYPES: Record<string, string> = { ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const HEADERS = {
  "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
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

function readBody(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 10_000) req.destroy(new Error("body too large"));
    });
    req.on("end", () => resolve(new URLSearchParams(data)));
    req.on("error", reject);
  });
}

const KIND: Record<Item["tool"], string> = { create_post: "Photo note", create_draft: "Draft", post_comment: "Comment", reply_comment: "Reply" };
const APPROVE_LIVE: Record<Item["tool"], string> = {
  create_post: "Approve and publish",
  create_draft: "Approve and save draft",
  post_comment: "Approve and send",
  reply_comment: "Approve and send reply",
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
    return `<dl><dt>Title</dt><dd class=title>${esc(a.title)}</dd><dt>Body</dt><dd class=text>${esc(a.body)}</dd><dt>Images, in posting order</dt><dd><ol class=imgs>${imgs}</ol></dd></dl>`;
  }
  const a = item.args as CommentArgs & Partial<ReplyArgs>;
  const note = `<dt>On note</dt><dd><a href="${esc(a.noteUrl)}" rel="noreferrer noopener" target="_blank" translate=no>${esc(a.noteUrl)}</a></dd>`;
  const target = item.tool === "reply_comment" ? `<dt>Replying to ${esc(a.commentAuthor)}</dt><dd class="text quote">${esc(a.commentText)}</dd>` : "";
  return `<dl>${note}${target}<dt>${item.tool === "reply_comment" ? "Your reply" : "Your comment"}</dt><dd class=text>${esc(a.text)}</dd></dl>`;
}

function card(item: Item, t: string, buttons: Array<[action: string, label: string]>, note = ""): string {
  const forms = buttons
    .map(([action, label]) => `<form method=post action="/decide"><input type=hidden name=t value="${t}"><input type=hidden name=id value="${item.id}"><button name=action value="${action}" class="${action}" aria-label="${esc(label)}: ${esc(KIND[item.tool])} ${esc(item.id)}">${esc(label)}</button></form>`)
    .join("");
  const last = item.history.at(-1)?.note;
  return `<article aria-labelledby="h-${item.id}"><header><h3 id="h-${item.id}">${KIND[item.tool]}</h3><span class="s ${item.status}">${STATUS[item.status]}</span></header>
<p class=meta>Queued ${when(item.createdAt)}. <code translate=no>${esc(item.id)}</code></p>${content(item, t)}${last ? `<p class=note>${esc(last)}</p>` : ""}${note ? `<p class=note>${esc(note)}</p>` : ""}${forms ? `<div class=row>${forms}</div>` : ""}</article>`;
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
details summary{cursor:pointer;font-weight:600;margin-top:2rem}`;

function page(o: ApprovalOptions): string {
  const t = o.token;
  const items = listItems(o.dir);
  const entries = readLedger(o.ledger);
  const now = new Date();
  const used = entries.filter((e) => e.event === "attempt" && e.dryRun === false && new Date(e.at).getTime() > now.getTime() - 24 * 3600_000).length;
  const halt = haltReason(entries);
  const waiting = (i: Item) => {
    if (i.approvedFor !== (o.dryRun ? "dry_run" : "live")) {
      const was = i.approvedFor === "live" ? "a live run" : "a dry run";
      return `Approved for ${was}, but the server now runs ${o.dryRun ? "dry" : "live"}. It will not run. Cancel it and approve again.`;
    }
    if (o.dryRun) return "Runs about 30 seconds after approval. Dry runs spend no budget.";
    const b = budgetCheck(entries, i.tool, now, o.limits);
    if (b.ok) return "Runs about 30 seconds after approval.";
    const next = Number.isFinite(b.retryAt.getTime()) ? ` Next slot ${new Intl.DateTimeFormat(undefined, { timeStyle: "short", dateStyle: "medium" }).format(b.retryAt)}.` : "";
    return `Waiting for budget: ${b.reason}.${next}`;
  };
  const approveLabel = (i: Item) => (o.dryRun ? "Approve dry run" : APPROVE_LIVE[i.tool]);
  const pending = items.filter((i) => i.status === "pending").map((i) => card(i, t, [["approve", approveLabel(i)], ["reject", "Reject"]]));
  const approved = items.filter((i) => i.status === "approved").map((i) => card(i, t, [["cancel", "Cancel before it runs"]], waiting(i)));
  const history = items.filter((i) => !["pending", "approved"].includes(i.status)).reverse().slice(0, 20).map((i) => card(i, t, []));
  return `<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><meta name=color-scheme content="light dark"><meta name=theme-color content="#eef1f4" media="(prefers-color-scheme: light)"><meta name=theme-color content="#15181c" media="(prefers-color-scheme: dark)"><title>Approvals, rednote-gate</title><style>${CSS}</style></head>
<body><a class=skip href="#queue">Skip to the queue</a><main>
<h1>Approve writes to RedNote</h1>
<div class="mode ${o.dryRun ? "dry" : "live"}">${o.dryRun ? "<b>Dry run.</b> Approved items fill in the form on RedNote but are never published or sent." : "<b>Live.</b> Approved items are published or sent from the account about 30 seconds after you approve."}
<p class=budget>Live writes in the last 24 hours: ${used} of ${o.limits.daily}. <a href="/?t=${t}">Refresh</a></p></div>
${halt ? `<div class=halt role=alert><b>Stopped.</b> RedNote showed: ${esc(halt)}. Nothing runs until you resume. Open the RedNote app and check the account first.<form method=post action="/resume"><input type=hidden name=t value="${t}"><div class=row><button class=approve>Resume</button></div></form></div>` : ""}
<section id=queue aria-labelledby=h-pending><h2 id=h-pending>Needs your decision (${pending.length})</h2>${pending.join("") || "<p class=note>Nothing waiting. When Claude queues a post, comment or reply, it shows up here.</p>"}</section>
<section aria-labelledby=h-approved><h2 id=h-approved>Approved, not run yet (${approved.length})</h2>${approved.join("") || "<p class=note>None.</p>"}</section>
<details><summary>History (${history.length})</summary>${history.join("") || "<p class=note>Nothing has run yet.</p>"}</details>
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
  if (req.headers.origin !== `http://${host}`) return send(403, "Cross-origin request refused.");
  const form = await readBody(req);
  if (!sameToken(form.get("t"), o.token)) return send(403, "Missing or wrong token.");
  const back = { Location: `/?t=${o.token}` };
  if (url.pathname === "/resume") {
    appendLedger(o.ledger, { at: new Date().toISOString(), event: "resumed", detail: "resumed from the approval page" });
    return send(303, "", undefined, back);
  }
  if (url.pathname === "/decide") {
    const action = ACTIONS[form.get("action") ?? ""];
    const id = form.get("id") ?? "";
    try {
      if (!action || readItem(o.dir, id).status !== action.from) return send(409, "That item is no longer in a state where this button applies. Refresh.");
      const approving = action.to === "approved";
      const note = approving ? (o.dryRun ? "approved for a dry run" : "approved to run live") : `${form.get("action")} on the approval page`;
      transition(o.dir, id, action.to, note, new Date(), approving ? { approvedFor: o.dryRun ? "dry_run" : "live" } : {});
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
