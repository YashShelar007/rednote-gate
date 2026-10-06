# rednote-gate

rednote-gate drives ONE dedicated throwaway RedNote (Xiaohongshu) account. Never point it at a primary or brand account. It works by browser automation, which is against RedNote's terms of service. The account can be rate limited or banned. Only use an account you can afford to lose.

It is a local MCP server for Claude Code, Claude Desktop and Codex. Reads run directly. Every write waits in a queue until a human clicks Approve on a local web page.

## Quick start

```bash
npm run setup
```

That installs Chromium, builds, opens the QR login for your throwaway account, and connects rednote-gate to Claude Code. Then, in Claude Code:

| Slash command | What happens |
| --- | --- |
| `/rednote-gate:post_photos` | Claude writes a photo note from your photos and a one-line brief, and queues it |
| `/rednote-gate:reply_to_comments` | Claude reads a note's comments, drafts up to 3 replies, and queues them |
| `/rednote-gate:research_topic` | Claude searches a topic, reads the top notes and comments, and summarises what works. Read only. |
| `/rednote-gate:review_queue` | Claude summarises what is waiting and what happened |

Or just ask in plain words ("post these two photos about my hike"). The first time you use a rednote tool, a small background service starts. It owns the browser, the approval page and the worker, and it keeps running after you close Claude Code, so the approval page always works and approved items always run. It closes the browser window after 5 idle minutes. Stop it with `npm run stop`. When something is queued, the approval page opens in your browser and your Mac shows a notification. You click Approve. About 30 seconds later it runs, and the page shows a screenshot of the result. You get a notification when it is done, or if RedNote ever shows a captcha.

Status: the four read flows were checked against the live site on 2026-10-06 (rednote.com account, headed). The four write flows passed dry runs on the live site the same day; no real write has been made yet. See [Last verified against the live site](#last-verified-against-the-live-site).

## What it does

rednote-gate is a local stdio MCP server. It needs Node 20 or newer. It is written in TypeScript and drives Playwright Chromium on your own machine.

Read tools run straight away:

| Tool | Arguments | Returns |
| --- | --- | --- |
| `rednote_login_status` | none | `site`, `loggedIn` (main site) and `creatorSession` (creator site, needed to publish) |
| `rednote_search` | `keyword`, `limit` (up to 30) | noteId, title, author, likes, url. The url carries an `xsec_token`. |
| `rednote_get_note` | `url` | noteId, title, body, author, tags, likes, collects, comment count, ipLocation, time |
| `rednote_get_comments` | `url`, `limit` (up to 50) | id, author, text, likes, reply count. First page only. |
| `rednote_queue_status` | `limit` | recent queue items: id, tool, status, last change. Never the approval link. |
| `rednote_open_approval_page` | none | opens the approval page in your browser. Never returns the link. |

Write tools only add an item to the queue and return its queue id. They never touch the browser.

| Tool | Arguments | What happens after approval |
| --- | --- | --- |
| `rednote_create_post` | `title` (RedNote's limit of 20: a CJK character counts 1, ASCII counts half), `body` (up to 1000 characters), `images` (1 to 9 absolute paths to JPEG, PNG or WebP files; the first is the cover) | publishes a photo note |
| `rednote_create_draft` | same as `rednote_create_post` | saves a draft instead of publishing |
| `rednote_post_comment` | `url`, `text` (up to 500 characters) | posts a comment on the note |
| `rednote_reply_comment` | `url`, `commentId`, `commentAuthor`, `commentText`, `text` (up to 500 characters) | replies to that comment |

For `rednote_reply_comment`, pass the id, author and text exactly as `rednote_get_comments` returned them. Before replying, the worker reads the comment with that id from the page and checks that its author and text still match exactly. If not, it does not reply.

Titles, comments and replies must be a single line: a line break would be typed as Enter, which can send a comment early. The body of a note may have line breaks.

Note URLs must look like `https://www.xiaohongshu.com/explore/<id>?xsec_token=...` (or `www.rednote.com` for overseas accounts). Take them from `rednote_search` results. Bare URLs without the token are refused, because RedNote answers them with a captcha. See [docs/friction.md](docs/friction.md).

## How the approval gate works

A short example:

1. You ask Claude: "Post a note about my desk setup with /Users/me/pics/desk.jpg."
2. Claude calls `rednote_create_post`. The server checks the image, copies it into the queue and hashes it. It returns a queue id such as `q_20261006T153012_ab12`. No browser opens. Nothing is posted.
3. You run `npm run approve` and open the link it prints. The page shows the exact title, body and image. You click Approve.
4. The worker checks the queue every 10 seconds. It waits 30 seconds after your click, so you can still press Cancel, then picks up the item if the budget allows. It writes an `attempt` line to the ledger, then opens the creator page, uploads the image and types the text.
5. In dry run mode (the default) it stops before the final click. The item becomes `dry_run`. In live mode (`RN_DRY_RUN=0`) it clicks publish. The item becomes `posted`.
6. Claude can call `rednote_queue_status` to see the result. It never gets the approval link.

Clicking Approve only marks the item. It does not post anything by itself. There is no approval in chat. Telling Claude "yes, post it" changes nothing.

### Statuses

```
pending  -> approved | rejected
approved -> posting  | rejected    (Cancel)
posting  -> posted | dry_run | failed | unknown
```

| Status | Meaning |
| --- | --- |
| `pending` | queued, waiting for a human |
| `approved` | a human clicked Approve. Waits for the worker and the budget. |
| `rejected` | a human clicked Reject, or Cancel on an approved item |
| `posting` | the worker is running it now |
| `posted` | a live attempt finished |
| `dry_run` | the worker ran the flow with dry run on. It navigated, uploaded images and typed text, but did not click the final button. |
| `failed` | a dry run hit an error, or a live attempt stopped before its final click (for example, the comment it should reply to changed). Nothing was sent. It can be queued again. |
| `unknown` | a live attempt hit an error after its final click, or the process died mid live attempt. It may or may not have posted. It is never retried. Check the account by hand. |

Queuing an identical write returns the existing id instead of a second item. Identical means same tool, same arguments and same image bytes. This applies while the first one is `pending`, `approved`, `posting`, `posted` or `unknown`.

## Guardrails

- **Approval in code.** Write tools only queue. The worker clicks the final button only when `RN_DRY_RUN=0` and the item is approved.
- **What you approve is what posts.** Images are copied into the queue and hashed when queued. Only real JPEG, PNG or WebP files pass, checked by file signature. Each image can be at most 20 MB. A note takes 1 to 9 images. That is a project limit, not RedNote's.
- **Daily budget.** At most `RN_DAILY_WRITES` live attempts (default 5) in any rolling 24 hours. Comments and replies also need `RN_COMMENT_GAP_MIN` minutes (default 10) since the last live comment or reply attempt. The budget is worked out from the ledger, so a restart does not reset it. Failed and unknown live attempts count. Dry runs do not. An approved item over budget waits. The approval page shows when the next slot opens.
- **Undo window.** The worker waits 30 seconds after Approve. Until then, Cancel stops it.
- **An approval is tied to its mode.** "Approve dry run" only ever runs as a dry run. If you restart in live mode, earlier dry-run approvals do not run; the page tells you to cancel and approve again.
- **Read back before sending.** After typing, every field is read back. If a topic or mention picker, or anything else, changed the text, it stops before the final click.
- **Crash safety.** The `attempt` line is written before the browser starts, so a crash still uses up budget. A live item cut off mid attempt becomes `unknown` and is never retried. A dry run cut off mid attempt becomes `failed`.
- **Checked again before sending.** Image hashes are re-checked before upload. A reply only goes out if the target comment still exists and its text still matches what you approved.
- **Halt on friction.** If RedNote shows a captcha or a "too frequent" warning, rednote-gate writes a `blocked` line to the ledger. It stops the worker and refuses read tools. Write tools can still queue, since queuing never touches the browser. It does not retry. The halt survives a restart. A human clicks Resume on the approval page to continue.
- **No bare note URLs.** URLs without `xsec_token` are refused before the browser opens.
- **One browser owner.** Only the service drives the browser, guarded by a lock file in `data/`. Every MCP client (Claude Code, Claude Desktop, Codex, several sessions at once) talks to that one service, so there is never a second browser on the account.
- **Dry run by default.** `RN_DRY_RUN` is `1` unless you set it to `0`.

## Terms of service warning

This project drives the RedNote website with a real browser and a real logged-in session. RedNote's terms do not allow this. Using it can get the account rate limited, restricted or banned. That risk is yours.

- Use ONE dedicated throwaway account. Never a primary account. Never a brand account.
- Keep writes few and far apart. The budget is a ceiling, not a target.
- Respect the law where you live and the people whose notes you read or reply to.

## Setup

You need Node 20 or newer, a RedNote account made for this purpose, and the phone that account is logged in on.

```bash
npm run setup
```

It runs these steps, which you can also run one by one:

```bash
npm install
npx playwright install chromium
npm run build
npm run login
npm run connect
```

`npm run connect` adds rednote-gate to Claude Code for all your projects (`claude mcp add --scope user`). For Claude Desktop or Codex, see below.

`npm run login` opens a visible browser at xiaohongshu.com. Overseas accounts get sent to rednote.com: the login follows, reloads on rednote.com and asks you to scan the new QR code. It records which site your account uses in `.session/site`. Scan the QR code with the throwaway account's phone. If the page shows you logged in but the terminal does not move on, press Enter there. It then visits creator.xiaohongshu.com to pick up the creator session; scan again if that site asks. It saves the session to `.session/state.json` with owner-only permissions (0600).

Quit your MCP client before running it: only one process may drive the browser.

That file is a credential. It is git-ignored. rednote-gate never prints it. Never share it, commit it or copy it to a shared disk.

Then add the server to your MCP client.

## Wiring into Claude Code, Claude Desktop and Codex

Use the absolute path to `dist/index.js` in your clone.

**Claude Code:**

```bash
claude mcp add rednote-gate -- node /ABSOLUTE/PATH/rednote-gate/dist/index.js
```

**Claude Desktop** (in `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "rednote-gate": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/rednote-gate/dist/index.js"],
      "env": { "RN_DRY_RUN": "1" }
    }
  }
}
```

**Codex:** add a server entry to Codex's MCP config with command `node`, args `["/ABSOLUTE/PATH/rednote-gate/dist/index.js"]`, and any env you need. See Codex's own docs for where that config lives.

The `env` block is optional. See [Environment variables](#environment-variables).

Never load a browser MCP, such as `@playwright/mcp`, in the same client session as rednote-gate. An agent with a browser could open the approval page and click Approve.

## The approval page

The page runs at `http://127.0.0.1:7317` while the MCP server runs. Change the port with `RN_APPROVAL_PORT`.

Get the link from the repo root:

```bash
npm run approve
```

It prints the URL with a secret token. The server makes a new token each time it starts, so get a fresh link after a restart. The link is also stored in `data/approval-url` with owner-only permissions.

The page shows:

- for posts and drafts: the exact title, body and images
- for comments: the comment text
- for replies: the comment being replied to, and the reply text
- live writes used in the last 24 hours, and when the next slot opens
- the mode: DRY RUN or LIVE
- a halt banner if a captcha or warning stopped the worker
- after each attempt, a screenshot of what the browser showed at the end
- it refreshes itself every 5 seconds while something is approved or running

It opens by itself when Claude queues a write (at most once a minute). `rednote_open_approval_page` opens it on request.

Buttons:

| Button | Does |
| --- | --- |
| Approve dry run, or in live mode Approve and publish, Approve and save draft, Approve and send, Approve and send reply | marks a pending item approved. It does not post. The worker runs it about 30 seconds later. |
| Reject | marks a pending item rejected |
| Cancel before it runs | rejects an approved item the worker has not started |
| Resume | clears a halt and writes a `resumed` line to the ledger |

How the page is protected:

- It binds to 127.0.0.1 only.
- It checks the Host header, which blocks DNS rebinding.
- Every request needs the token.
- State changes are POST only and must come from the same origin. This blocks other websites.
- It cannot be framed. It sends a strict Content Security Policy and no referrer.

## Queue file format

All data lives in `data/` at the repo root. `RN_DATA_DIR` moves it. Everything in it is git-ignored.

| Path | What |
| --- | --- |
| `data/queue/<id>.json` | one queue item |
| `data/queue/<id>/<n>.<ext>` | images copied in when the item was queued |
| `data/ledger.jsonl` | the ledger |
| `data/screenshots/<id>.png` | screenshot of the attempt |
| `data/approval-url` | the approval link (0600) |
| `data/lock` | the service's process id; only the service drives the browser |
| `data/service.log` | the service's log |

A queue item:

```json
{
  "id": "q_20261006T153012_ab12",
  "tool": "create_post",
  "args": { "title": "...", "body": "...", "images": ["q_20261006T153012_ab12/0.jpg"] },
  "imageSha256": ["..."],
  "contentHash": "...",
  "createdAt": "2026-10-06T15:30:12.000Z",
  "status": "pending",
  "history": [{ "status": "pending", "at": "2026-10-06T15:30:12.000Z" }]
}
```

Image paths in `args.images` are relative to `data/queue/`. `imageSha256` holds one hash per image. `contentHash` covers the tool, the arguments and the image hashes, and is what duplicate checks compare. Each status change adds one entry to `history`.

## Ledger format

`data/ledger.jsonl` holds one JSON object per line.

| Field | Meaning |
| --- | --- |
| `at` | time of the event |
| `event` | `attempt`, `result`, `blocked` or `resumed` |
| `id` | queue id |
| `tool` | which write tool |
| `dryRun` | whether dry run was on |
| `outcome` | the item's final status: `posted`, `dry_run`, `failed` or `unknown` |
| `detail` | a short note |
| `screenshot` | path to the screenshot |

Not every field appears on every line. An `attempt` line is written before the browser starts. A `result` line follows when the attempt ends. If the process dies in between, there is an `attempt` with no `result`. On the next start the item becomes `unknown` (live) or `failed` (dry run), and a `result` line records that.

The budget counts `attempt` lines with `dryRun: false` from the last 24 hours. The halt also comes from the ledger: a `blocked` line with no later `resumed` line means halted, even after a restart.

If a line is not valid JSON, writes stop until you fix or remove that line. A budget that cannot be read fails closed.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `RN_SITE` | from `npm run login` | `xiaohongshu.com` (mainland accounts) or `rednote.com` (overseas accounts) |
| `RN_HEADLESS` | headed | `1` runs Chromium headless |
| `RN_DRY_RUN` | `1` | `0` lets the worker click the final button on approved items |
| `RN_DAILY_WRITES` | `5` | live attempts allowed in any rolling 24 hours |
| `RN_COMMENT_GAP_MIN` | `10` | minutes between live comment or reply attempts |
| `RN_APPROVAL_PORT` | `7317` | approval page port |
| `RN_DATA_DIR` | `<repo>/data` | queue, ledger, screenshots, lock |
| `RN_SESSION_PATH` | `<repo>/.session/state.json` | saved login session |
| `RN_OPEN_APPROVAL` | on | `0` stops the approval page opening by itself |
| `RN_NOTIFY` | on | `0` turns off Mac notifications |
| `RN_TYPE_MIN_MS` | `40` | shortest delay per typed character |
| `RN_TYPE_MAX_MS` | `140` | longest delay per typed character |

Limits and the port must be whole numbers. A typo stops the server with an error instead of turning a limit off.

Set these in your MCP client's env block. `npm run login` and `npm run approve` read them from your shell. If you change `RN_DATA_DIR` or `RN_SESSION_PATH` in the client, export the same values before running those commands.

Dry run is not free of side effects. It opens the page, uploads images to RedNote's creator page and types the text. It only skips the final publish, save or send click.

## What it does not do

- Post anything without a human click on Approve. There is no approval in chat.
- Use more than one account, more than one browser context, or run writes at the same time.
- Bulk post, or schedule posts nobody is watching.
- Solve captchas, or retry after a block.
- Like, favorite, follow or send messages.
- Run the account in a cloud browser.
- Touch a primary or brand account.

## Known limits

- **A browser agent could approve.** An agent with its own browser tool on the same machine could open the approval page and click Approve. Never load a browser MCP in the same client session. The same goes for any process running as your user: it can read `data/approval-url`. The gate stops the model acting through rednote-gate's tools. It cannot stop other software you run.
- **The service keeps running.** It starts on first use and stays up until `npm run stop` or a reboot. After changing settings or updating the code, run `npm run stop`; the next tool call starts it fresh. Its log is `data/service.log`.
- **Selectors drift.** RedNote changes its pages. The selectors live in the `SEL` object in `src/rednote.ts`. Fix them there. Record the evidence in the capture block in [PROTOTYPE-RUNSHEET.md](PROTOTYPE-RUNSHEET.md) and in [docs/friction.md](docs/friction.md).
- **Unknown blocks a re-queue.** An `unknown` item blocks an identical write. If you check by hand and it did not post, change the text before queuing it again.
- **Comments are first page only.**
- **Headed by default.** A Chromium window opens when a browser tool runs and stays open as one tab. Set `RN_HEADLESS=1` once you trust it.
- **Writes are not verified live yet.** See the table below.

## Anti-bot measures (disclosed on purpose)

The owner decided on 2026-10-06 to keep these. They are listed here so nobody is surprised.

- Human-paced typing, with a random delay per character and random pauses.
- Chromium starts with `--disable-blink-features=AutomationControlled`.
- A fixed desktop Chrome 124 macOS user agent. It does not match the newer Chromium that Playwright actually runs.

There is no captcha solving. There is no fingerprint spoofing beyond the three items above.

RedNote's pages contain hidden decoy buttons that a person cannot see or click. rednote-gate acts only on visible elements, the ones a person would click, and never forces a click. See [docs/friction.md](docs/friction.md).

## Last verified against the live site

| Flow | Tool | Status as of 2026-10-06 |
| --- | --- | --- |
| Login status | `rednote_login_status` | verified headed 2026-10-06 (rednote.com); headless not yet |
| Search | `rednote_search` | verified headed 2026-10-06 (rednote.com); headless not yet |
| Get note | `rednote_get_note` | verified headed 2026-10-06 (rednote.com); headless not yet |
| Get comments | `rednote_get_comments` | verified headed 2026-10-06 (rednote.com); headless not yet |
| Create post | `rednote_create_post` | dry run verified headed 2026-10-06 (rednote.com); no real post yet |
| Create draft | `rednote_create_draft` | dry run verified headed 2026-10-06 (rednote.com); no real draft yet |
| Post comment | `rednote_post_comment` | dry run verified headed 2026-10-06 (rednote.com); no real comment yet |
| Reply comment | `rednote_reply_comment` | dry run verified headed 2026-10-06 (rednote.com); no real reply yet |

[PROTOTYPE-RUNSHEET.md](PROTOTYPE-RUNSHEET.md) is how each row gets checked. Update this table with the date and result after each run.

## Credits

- Selectors and page-state paths were informed by [xpzouying/xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp) (Apache-2.0, commit a5c8f77) and [sykuang/rednote-mcp](https://github.com/sykuang/rednote-mcp) (MIT, commit 7e87754).
- The rule that an uncertain write becomes `unknown` and is never retried follows [mimi17-shq/xiaohongshu-mcp-reliable](https://github.com/mimi17-shq/xiaohongshu-mcp-reliable) (Apache-2.0).

See [docs/landscape.md](docs/landscape.md) for how these and other projects compare.

## License

MIT. Author: Yash Shelar. See [LICENSE](LICENSE).

rednote-gate is independent and unaffiliated. RedNote and Xiaohongshu are trademarks of their owner.
