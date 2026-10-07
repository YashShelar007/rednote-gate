# rednote-gate

[![npm version](https://img.shields.io/npm/v/rednote-gate)](https://www.npmjs.com/package/rednote-gate) [![License: MIT](https://img.shields.io/github/license/YashShelar007/rednote-gate)](LICENSE) [![CI](https://github.com/YashShelar007/rednote-gate/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/YashShelar007/rednote-gate/actions/workflows/ci.yml)

rednote-gate drives ONE dedicated throwaway RedNote (Xiaohongshu) account. Never point it at a primary or brand account. It works by browser automation, which is against RedNote's terms of service. The account can be rate limited or banned. Only use an account you can afford to lose.

<img src="site/assets/approval-light.png" width="380" alt="The approval page in dry run mode. Meters show 1 of 5 writes and 2 of 10 likes used in the last 24 hours. Below them, a photo note titled Sunrise hike above the clouds waits for a decision, with its body, three topics, two images, and the buttons Approve dry run and Reject.">

Website: https://yashshelar007.github.io/rednote-gate/

It is a local MCP server for Claude Code, Claude Desktop and Codex. Reads run directly. Every write waits in a queue until a human clicks Approve on a local web page.

## Quick start

### Install from npm

```bash
npm install -g rednote-gate
rednote-gate setup
```

That installs Chromium, opens the QR login for your throwaway account, and connects rednote-gate to Claude Code. Your data and login live in `~/.rednote-gate`.

### Or from a clone

```bash
git clone https://github.com/YashShelar007/rednote-gate.git
cd rednote-gate
npm run setup
```

Same steps, plus the build. A clone that already has a login in `.session/` keeps its data in the clone folder.

Then, in Claude Code:

| Slash command | What happens |
| --- | --- |
| `/rednote-gate:post_photos` | Claude writes a photo note from your photos and a one-line brief, and queues it |
| `/rednote-gate:reply_to_comments` | Claude reads a note's comments, drafts up to 3 replies, and queues them |
| `/rednote-gate:post_from_concept` | Claude researches a concept, writes an original note, renders text-card images, and queues it |
| `/rednote-gate:research_topic` | Claude searches a topic, reads the top notes and comments, and summarises what works. Read only. |
| `/rednote-gate:review_queue` | Claude summarises what is waiting and what happened |
| `/rednote-gate:help` | every tool and workflow, your mode, and what is left of today's budget |

Or just ask in plain words ("post these two photos about my hike"). The first time you use a rednote tool, a small background service starts. It owns the browser, the approval page and the worker, and it keeps running after you close Claude Code, so the approval page always works and approved items always run. It closes the browser window after 5 idle minutes. Stop it with `rednote-gate stop` (`npm run stop` in a clone). When something is queued, the approval page opens in your browser and your Mac shows a notification. You click Approve. About 30 seconds later it runs, and the page shows a screenshot of the result. You get a notification when it is done, or if RedNote ever shows a captcha.

Status: every flow was checked against the live site on 2026-10-06 on a rednote.com account, headed: four reads, and one real publish, draft, comment and reply, each approved by a human on the approval page. See [Last verified against the live site](#last-verified-against-the-live-site).

## What it does

rednote-gate is a local stdio MCP server. It needs Node 20 or newer. It is written in TypeScript and drives Playwright Chromium on your own machine.

Read tools run straight away:

| Tool | Arguments | Returns |
| --- | --- | --- |
| `rednote_login_status` | none | `site`, `loggedIn` (main site) and `creatorSession` (creator site, needed to publish) |
| `rednote_search` | `keyword`, `limit` (up to 30) | noteId, title, author, likes, url. The url carries an `xsec_token`. |
| `rednote_get_note` | `url` | noteId, title, body, author, tags, likes, collects, comment count, ipLocation, time |
| `rednote_get_comments` | `url`, `limit` (up to 50) | id, author, text, likes, reply count. First page only. |
| `rednote_make_cards` | `cards` (1 to 9: title, up to 8 lines, footer), optional `theme` (`notebook`, `sticky`, `chalkboard`, `blueprint`) | renders 1080x1440 text-card PNGs on your computer and returns their paths. Never touches RedNote. |
| `rednote_my_notes` | `limit` (up to 30) | your own notes, newest first: noteId, title, likes, url |
| `rednote_queue_status` | `limit` | recent queue items: id, tool, status, last change. Never the approval link. |
| `rednote_help` | none | what rednote-gate can do, the current mode, and today's remaining budget |
| `rednote_open_approval_page` | none | opens the approval page in your browser. Never returns the link. |

Write tools only add an item to the queue and return its queue id. They never touch the browser.

| Tool | Arguments | What happens after approval |
| --- | --- | --- |
| `rednote_create_post` | `title` (RedNote's limit of 20: a CJK character counts 1, ASCII counts half), `body` (up to 1000 characters, emoji fine, no `#`), `images` (1 to 9 absolute paths to JPEG, PNG or WebP files; the first is the cover), optional `topics` (up to 5, without `#`) | publishes a photo note; each topic is added as a linked RedNote topic when the picker offers exactly that topic, otherwise as plain `#text` |
| `rednote_create_draft` | same as `rednote_create_post` | saves a draft instead of publishing |
| `rednote_create_video_post` | `title`, `body`, `video` (absolute path to one MP4 or MOV, up to 500 MB, a project limit), optional `topics` | publishes a video note once RedNote has processed it |
| `rednote_post_comment` | `url`, `text` (up to 500 characters) | posts a comment on the note |
| `rednote_like_note` | `url`, optional `noteTitle` | likes the note (own daily cap, see `RN_DAILY_LIKES`); refuses a note already liked |
| `rednote_reply_comment` | `url`, `commentId`, `commentAuthor`, `commentText`, `text` (up to 500 characters) | replies to that comment |

For `rednote_reply_comment`, pass the id, author and text exactly as `rednote_get_comments` returned them. Before replying, the worker reads the comment with that id from the page and checks that its author and text still match exactly. If not, it does not reply.

Titles, comments and replies must be a single line: a line break would be typed as Enter, which can send a comment early. The body of a note may have line breaks.

Note URLs must look like `https://www.xiaohongshu.com/explore/<id>?xsec_token=...` (or `www.rednote.com` for overseas accounts). Take them from `rednote_search` results. Bare URLs without the token are refused, because RedNote answers them with a captcha. See [docs/friction.md](docs/friction.md).

## How the approval gate works

A short example:

1. You ask Claude: "Post a note about my desk setup with /Users/me/pics/desk.jpg."
2. Claude calls `rednote_create_post`. The server checks the image, copies it into the queue and hashes it. It returns a queue id such as `q_20261006T153012_ab12`. No browser opens. Nothing is posted.
3. You run `rednote-gate approve` and open the link it prints. The page shows the exact title, body and image. You click Approve.
4. The worker checks the queue every 10 seconds. It waits 30 seconds after your click, so you can still press Cancel, then picks up the item if the budget allows. It writes an `attempt` line to the ledger, then opens the creator page, uploads the image and types the text.
5. In dry run mode (the default) it stops before the final click. The item becomes `dry_run`. In live mode (`rednote-gate live`) it clicks publish. The item becomes `posted`.
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

- **Approval in code.** Write tools only queue. The worker clicks the final button only in live mode, and only on an approved item.
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
- **Dry run by default.** It stays in dry run until you run `rednote-gate live` or go live on the Settings page. The mode saved in `settings.json` wins over `RN_DRY_RUN`.

## Terms of service warning

This project drives the RedNote website with a real browser and a real logged-in session. RedNote's terms do not allow this. Using it can get the account rate limited, restricted or banned. That risk is yours.

Two Xiaohongshu notices from 2026 also apply (checked 2026-10-07). On 2026-03-10 it announced action against "AI 托管" (AI hosting) accounts ([IT之家 report](https://www.ithome.com/0/927/689.htm)). An account that now and then lets AI hosting write, post or interact for it gets warnings and reduced distribution. An account that registers, posts or interacts directly through AI hosting tools is banned, and so is one whose public notes were all posted that way. On 2026-04-27 it published rules for AI content ([IT之家 report](https://www.ithome.com/0/944/156.htm)). Creators should label notes that AI generated or polished when they publish them, and the platform adds its own label to AI content left unlabeled. Using AI to run an account against the rules is punished in steps, up to a ban.

An Approve click does not make an account compliant. A throwaway account that only posts through rednote-gate matches the ban description in the March notice.

- Use ONE dedicated throwaway account. Never a primary account. Never a brand account.
- Keep writes few and far apart. The budget is a ceiling, not a target.
- Respect the law where you live and the people whose notes you read or reply to.

## Setup

You need Node 20 or newer, a RedNote account made for this purpose, and the phone that account is logged in on.

```bash
npm install -g rednote-gate
rednote-gate setup
```

`rednote-gate setup` installs Chromium with the package's own Playwright, then runs these two steps, which you can also run one by one:

```bash
rednote-gate login
rednote-gate connect
```

From a clone, `npm run setup` does the same after `npm install` and `npm run build`. In a clone, `npm run login`, `connect`, `live`, `dry`, `stop` and `approve` run the same commands.

`rednote-gate connect` adds rednote-gate to Claude Code for all your projects (`claude mcp add --scope user`). It also prints the config for Claude Desktop and Codex. See below.

It starts in dry run: approved items fill in the form but never publish. When a dry run looks right, switch modes with one command:

```bash
rednote-gate live
```

It says what live means and asks you to confirm. `rednote-gate live --yes` skips the question. The mode is saved to `settings.json`, the same file the dashboard's Settings page writes, and the service restarts on the next tool call. `rednote-gate dry` switches back. Approvals given in one mode never run in the other.

More commands:

| Command | Does |
| --- | --- |
| `rednote-gate status` | version, site, mode, what is left of today's budget, whether the service runs |
| `rednote-gate doctor` | offline checks, one pass or fail line each: Node, Chromium, login, settings, ledger, service. Never contacts RedNote. |
| `rednote-gate approve` | prints the approval page link |
| `rednote-gate stop` | stops the background service |
| `rednote-gate help` | all commands |

With no command, `rednote-gate` runs the MCP server. That is what MCP clients start.

### Where your data lives

Data and login live in `~/.rednote-gate`: `data/` for the queue, ledger and settings, and `.session/` for the login. `RN_HOME` moves both. A clone that already has `.session/` from an older version keeps using its own folder.

`rednote-gate login` opens a visible browser at xiaohongshu.com. Overseas accounts get sent to rednote.com: the login follows, reloads on rednote.com and asks you to scan the new QR code. It records which site your account uses in `.session/site`. Scan the QR code with the throwaway account's phone. If the page shows you logged in but the terminal does not move on, press Enter there. It then visits creator.xiaohongshu.com to pick up the creator session; scan again if that site asks. It saves the session to `.session/state.json` with owner-only permissions (0600).

Quit your MCP client before running it: only one process may drive the browser.

That file is a credential. It is git-ignored. rednote-gate never prints it. Never share it, commit it or copy it to a shared disk.

Then add the server to your MCP client.

## Wiring into Claude Code, Claude Desktop and Codex

`rednote-gate connect` prints all three for your install. With a global npm install the command is `rednote-gate`. From a clone, use `node` with the absolute path to `dist/cli.js`.

**Claude Code:**

```bash
claude mcp add rednote-gate --scope user -- rednote-gate
```

**Claude Desktop** (in `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "rednote-gate": {
      "command": "rednote-gate",
      "args": []
    }
  }
}
```

Claude Desktop may not see your shell's PATH. If it cannot start the server, use absolute paths: `command` is the output of `which node`, and `args` is `["<npm root -g>/rednote-gate/dist/cli.js"]`.

**Codex** (in `~/.codex/config.toml`):

```toml
[mcp_servers.rednote-gate]
command = "rednote-gate"
args = []
```

An `env` block is optional. See [Environment variables](#environment-variables).

Never load a browser MCP, such as `@playwright/mcp`, in the same client session as rednote-gate. An agent with a browser could open the approval page and click Approve.

## The approval page

The page runs at `http://127.0.0.1:7317` while the MCP server runs. Change the port with `RN_APPROVAL_PORT`.

Get the link:

```bash
rednote-gate approve
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

The page also shows today's usage as meters, and links to **Settings**: mode (dry run or live, with a confirmation tick to go live), writes per day, likes per day, minutes between comments, and notifications. Settings are saved to `data/settings.json` and apply to the next item that runs, without a restart. They cannot go past the hard maximums: 20 writes, 50 likes, 2 minutes between comments.

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

All data lives in `~/.rednote-gate/data/`, or in `data/` in a clone that already had a login. `RN_HOME` or `RN_DATA_DIR` moves it. The folder is owner-only. In a clone it is git-ignored.

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
| `RN_HOME` | `~/.rednote-gate` | folder for `data/` and `.session/`. A clone that already has `.session/` uses the clone folder instead. |
| `RN_SITE` | from `rednote-gate login` | `xiaohongshu.com` (mainland accounts) or `rednote.com` (overseas accounts) |
| `RN_HEADLESS` | headed | `1` runs Chromium headless |
| `RN_DRY_RUN` | `1` | `0` lets the worker click the final button on approved items |
| `RN_DAILY_WRITES` | `5` | live attempts allowed in any rolling 24 hours |
| `RN_COMMENT_GAP_MIN` | `10` | minutes between live comment or reply attempts |
| `RN_DAILY_LIKES` | `10` | live likes allowed in any rolling 24 hours, separate from `RN_DAILY_WRITES` |
| `RN_APPROVAL_PORT` | `7317` | approval page port |
| `RN_DATA_DIR` | `<RN_HOME>/data` | queue, ledger, settings, screenshots, lock |
| `RN_SESSION_PATH` | `<RN_HOME>/.session/state.json` | saved login session |
| `RN_OPEN_APPROVAL` | on | `0` stops the approval page opening by itself |
| `RN_NOTIFY` | on | `0` turns off Mac notifications |
| `RN_TYPE_MIN_MS` | `40` | shortest delay per typed character |
| `RN_TYPE_MAX_MS` | `140` | longest delay per typed character |

Limits and the port must be whole numbers. A typo stops the server with an error instead of turning a limit off.

The dashboard's Settings page writes `data/settings.json`, which wins over these variables for limits, mode and notifications.

Set these in your MCP client's env block. The `rednote-gate` commands read them from your shell. If you set `RN_HOME`, `RN_DATA_DIR` or `RN_SESSION_PATH`, export the same values in your shell. `rednote-gate connect` copies those three into the Claude Code entry.

Dry run is not free of side effects. It opens the page, uploads images to RedNote's creator page and types the text. It only skips the final publish, save or send click.

## What it does not do

- Post anything without a human click on Approve. There is no approval in chat.
- Use more than one account, more than one browser context, or run writes at the same time.
- Bulk post, or schedule posts nobody is watching.
- Solve captchas, or retry after a block.
- Favorite, follow or send messages. (Likes were added on 2026-10-06 at the owner's request, behind the same approval page and their own daily cap.)
- Run the account in a cloud browser.
- Touch a primary or brand account.

## Known limits

- **A browser agent could approve.** An agent with its own browser tool on the same machine could open the approval page and click Approve. Never load a browser MCP in the same client session. The same goes for any process running as your user: it can read `data/approval-url`. The gate stops the model acting through rednote-gate's tools. It cannot stop other software you run.
- **The service keeps running.** It starts on first use and stays up until `rednote-gate stop` or a reboot. After updating, run `rednote-gate stop`; the next tool call starts it fresh. Settings apply without a restart. Its log is `data/service.log`.
- **Selectors drift.** RedNote changes its pages. The selectors live in the `SEL` object in `src/rednote.ts`. Fix them there. Record the evidence in the capture block in [PROTOTYPE-RUNSHEET.md](PROTOTYPE-RUNSHEET.md) and in [docs/friction.md](docs/friction.md).
- **Unknown blocks a re-queue.** An `unknown` item blocks an identical write. If you check by hand and it did not post, change the text before queuing it again.
- **Drafts stay in rednote-gate's browser.** RedNote's web creator site keeps drafts in the browser, not in your account (its own notice says so). A draft saved by rednote-gate does not appear in your phone app. rednote-gate keeps it across restarts by saving the browser's IndexedDB with the session; to finish it, open the creator site's 草稿箱 in rednote-gate's browser.
- **Comments are first page only.**
- **Headed by default.** A Chromium window opens when a browser tool runs and stays open as one tab. Set `RN_HEADLESS=1` once you trust it.

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
| My notes | `rednote_my_notes` | verified headed 2026-10-06 (rednote.com) |
| Topics and emoji in a post | `rednote_create_post` with `topics` | live verified 2026-10-06 (rednote.com): 4 linked topics in the note's tag list, 4 emoji kept |
| Video note | `rednote_create_video_post` | dry run verified 2026-10-06 (rednote.com): uploaded, processed, topic linked, 发布 found; no real video yet |
| Text cards and `post_from_concept` | `rednote_make_cards` | live verified 2026-10-06 (rednote.com): researched a concept, rendered 4 cards, published them as a note |
| Like | `rednote_like_note` | live verified 2026-10-06 (rednote.com): liked state confirmed after the click, count 151 to 152 |
| Get comments | `rednote_get_comments` | verified headed 2026-10-06 (rednote.com); headless not yet |
| Create post | `rednote_create_post` | live verified 2026-10-06 (rednote.com): note published, listed by `rednote_my_notes` |
| Create draft | `rednote_create_draft` | live verified 2026-10-06 (rednote.com): saved, but only in rednote-gate's browser (see Known limits) |
| Post comment | `rednote_post_comment` | live verified 2026-10-06 (rednote.com) |
| Reply comment | `rednote_reply_comment` | live verified 2026-10-06 (rednote.com); held 9 minutes by the comment gap, then sent on its own |

[PROTOTYPE-RUNSHEET.md](PROTOTYPE-RUNSHEET.md) is how each row gets checked. Update this table with the date and result after each run.

## Credits

- Selectors and page-state paths were informed by [xpzouying/xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp) (Apache-2.0, commit a5c8f77) and [sykuang/rednote-mcp](https://github.com/sykuang/rednote-mcp) (MIT, commit 7e87754).
- The rule that an uncertain write becomes `unknown` and is never retried follows [mimi17-shq/xiaohongshu-mcp-reliable](https://github.com/mimi17-shq/xiaohongshu-mcp-reliable) (Apache-2.0).

See [docs/landscape.md](docs/landscape.md) for how these and other projects compare.

## License

MIT. Author: Yash Shelar. See [LICENSE](LICENSE).

rednote-gate is independent and unaffiliated. RedNote and Xiaohongshu are trademarks of their owner.
