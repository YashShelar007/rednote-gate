# Live-site verification run sheet

This is how each flow gets checked against the real RedNote site. You run rednote-gate itself, headed, on the throwaway account, and watch the browser window. Nothing here uses a separate browser tool.

The goal is not the posts. The goal is the capture blocks at the bottom. They are the evidence for the "Last verified" table in [README.md](README.md) and for any selector fix in `src/rednote.ts`.

## Before you start (once)

1. **Throwaway account.** Make a RedNote account in the phone app for this purpose only. Never a primary or brand account. Keep the phone next to you.
2. **Build and log in.**

   ```bash
   npm install
   npx playwright install chromium
   npm run build
   npm run login
   ```

   Scan the QR code with the throwaway phone. Let it finish the visit to creator.xiaohongshu.com.
3. **Add rednote-gate to your MCP host** as shown in the README. Run `npm run dry` so it starts in dry run. The mode saved in `settings.json` wins over `RN_DRY_RUN`. Leave `RN_HEADLESS` unset, so the browser window is visible.
4. **Remove every browser MCP server from that host session.** Never load a browser MCP server such as `@playwright/mcp` in the same host session as rednote-gate. An agent with a browser could open the approval page and click Approve. In Claude Code, run `claude mcp list` and check before every session.

## Rules for every session

- Watch the browser window the whole time.
- Reads first. Writes only after every read works.
- Dry run before every live write.
- At most one live write per evening. Leave days between live writes.
- Stop at the first sign of friction: captcha, slider, "too frequent", a login prompt. Record it in [docs/friction.md](docs/friction.md) before you do anything else.
- Fill the capture block for the flow before you close the session.

## Part 1: read ladder (one evening)

Ask your agent in plain words. Do these in order. Do not skip ahead.

| # | Ask the agent | Tool | Check |
| --- | --- | --- | --- |
| R1 | "Check the RedNote login status." | `rednote_login_status` | says logged in |
| R2 | "Search RedNote for 奖学金, 5 results." | `rednote_search` | 5 results. Each url carries `xsec_token`. |
| R3 | "Get the note at <url from R2>." | `rednote_get_note` | title, body, author, counts match what the window shows |
| R4 | "Get the first 10 comments on <same url>." | `rednote_get_comments` | id, author, text look right |
| R5 | "Get the note at https://www.xiaohongshu.com/explore/<id from R2>." | `rednote_get_note` | refused before any browser opens. Bare URLs cause a captcha. |

If R1 says logged out, run `npm run login` again before going on.

## Part 2: write ladder (days apart)

Order: publish, draft, comment, reply. One flow per evening. Example schedule:

| Day | Flow |
| --- | --- |
| 1 | read ladder |
| 3 | W1 publish: dry run, then one live post |
| 5 | W2 draft: dry run, then one live draft |
| 7 | W3 comment: dry run, then one live comment |
| 9 | W4 reply: dry run, then one live reply |

Each write flow goes the same way:

1. **Dry run.** In dry run (`npm run dry`), ask the agent to queue the write. It returns a queue id.
2. Run `npm run approve` from the repo root and open the link. Check that the page says DRY RUN. Check the exact content. Click Approve. The worker starts about 30 seconds later; Cancel works until then.
3. Watch the window. Within about 10 seconds the worker opens the page, uploads images and types the text. It stops before the final click. Note that dry run still uploads images to RedNote's creator page.
4. Check the item is `dry_run` (ask the agent for `rednote_queue_status`). Look at `data/screenshots/<id>.png` and the last lines of `data/ledger.jsonl`.
5. **Live.** If the dry run looked right, run `npm run live` and confirm. It stops the service, and the next tool call starts it with a new token, so get a fresh link with `npm run approve`. Check the page says LIVE.
6. Ask the agent to queue the same write again. A finished dry run does not block an identical item, so you get a new id. Approve it once. Watch.
7. Check the item is `posted`. Then check on the phone that it really appeared.
8. Run `npm run dry`.
9. Fill the capture block. Update the README table with the date and result.

Flow notes:

- **W1 publish.** Use one small image you own. Plain test text.
- **W2 draft.** Check the draft shows in the account's drafts, and that nothing was published.
- **W3 comment.** Comment on the test note from W1, not on a stranger's note. Get its url from `rednote_search`, since bare URLs are refused. If the test note is not in search yet, try again another day.
- **W4 reply.** Call `rednote_get_comments` on the W1 note first. Reply to the W3 comment. Pass its id, author and text exactly as returned. The worker checks the comment still exists and its text matches before it replies.

## If something goes wrong

| What you see | What to do |
| --- | --- |
| Halt banner, `blocked` line in the ledger | rednote-gate has stopped the worker and refuses reads. Look at the account on the phone. Record it in docs/friction.md. Click Resume only on a later day. |
| Item `unknown` | Never retried. Check the account by hand to see if it posted. Record what you found in the capture block. An `unknown` item blocks an identical write, so change the text if you need to queue it again. |
| Item `failed` | A dry run hit an error. Nothing could have posted. Read the screenshot and the ledger `detail`. |
| A selector does not match | Fix it in the `SEL` object in `src/rednote.ts`. Rebuild. Repeat the dry run. Write the change in the capture block. |
| Item stays `approved` | The budget is full, rednote-gate is halted, or the client is not running. The approval page shows when the next slot opens. |

## Capture blocks

Fill one block per flow. Write what you saw in the window, not what the code is meant to do. Element labels are the visible text or role, plus the `SEL` key that matched it.

### Login status (R1)

```
DATE:
START URL:
STEPS:
ELEMENT LABELS:
WAITS THAT MATTERED:
FRICTION:
WHAT SUCCEEDED:
SEL CHANGES:
```

### Search (R2)

```
DATE:
START URL:
STEPS:
ELEMENT LABELS:
WAITS THAT MATTERED:
FRICTION:
WHAT SUCCEEDED:
SEL CHANGES:
```

### Get note (R3, R5)

```
DATE:
START URL:
STEPS:
ELEMENT LABELS:
WAITS THAT MATTERED:
FRICTION:
WHAT SUCCEEDED:
BARE URL REFUSED (R5):
SEL CHANGES:
```

### Get comments (R4)

```
DATE:
START URL:
STEPS:
ELEMENT LABELS:
WAITS THAT MATTERED:
FRICTION:
WHAT SUCCEEDED:
SEL CHANGES:
```

### Create post (W1)

```
DRY RUN:  date / queue id / status / screenshot
LIVE:     date / queue id / status / screenshot
START URL:
STEPS:
ELEMENT LABELS:
WAITS THAT MATTERED:
FRICTION:
WHAT SUCCEEDED (seen on the phone?):
SEL CHANGES:
```

### Create draft (W2)

```
DRY RUN:  date / queue id / status / screenshot
LIVE:     date / queue id / status / screenshot
START URL:
STEPS:
ELEMENT LABELS:
WAITS THAT MATTERED:
FRICTION:
WHAT SUCCEEDED (draft present, nothing published?):
SEL CHANGES:
```

### Post comment (W3)

```
DRY RUN:  date / queue id / status / screenshot
LIVE:     date / queue id / status / screenshot
START URL:
STEPS:
ELEMENT LABELS:
WAITS THAT MATTERED:
FRICTION:
WHAT SUCCEEDED (seen on the phone?):
SEL CHANGES:
```

### Reply comment (W4)

```
DRY RUN:  date / queue id / status / screenshot
LIVE:     date / queue id / status / screenshot
START URL:
STEPS:
ELEMENT LABELS:
WAITS THAT MATTERED:
FRICTION:
WHAT SUCCEEDED (reply under the right comment?):
SEL CHANGES:
```
