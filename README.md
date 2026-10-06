# rednote-mcp

An MCP server that lets Claude / Codex / any MCP client drive a **RedNote (Xiaohongshu)** account:
search and read notes & comments, and **create posts, save drafts, post comments, and reply to
comments** — via Playwright browser automation against a logged-in session.

> **Read this first — the honest constraints.**
>
> - RedNote has **no official write API**. Everything here is browser automation, which **breaches
>   RedNote's Terms of Service** and means the **account can be rate-limited or banned**. Use a
>   **dedicated** account you're willing to lose — never a primary/brand account.
> - It is **fragile**: RedNote changes its UI and anti-bot defences, so the DOM selectors in
>   `src/rednote.ts` _will_ drift. Every selector is centralised in one `SEL` object and marked
>   `VERIFY`, so when a flow breaks you fix it in one place.
> - The write flows (publish / draft / comment / reply) in this scaffold are written **by reference**
>   to how existing open-source RedNote MCP servers do it, and must be **verified against the live
>   site on first run** (see `PROTOTYPE-RUNSHEET.md`).

## How it's meant to be built (the hybrid plan)

This repo is the **end goal: your own, self-contained server.** The fastest way to make its flows
_correct_ is a short prototyping step first:

1. **Prototype** with Microsoft's off-the-shelf [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp)
   and let Claude discover exactly what works on RedNote — the real pages, the element labels, the
   waits, the anti-bot behaviour. **Capture** each working flow (template in `PROTOTYPE-RUNSHEET.md`).
2. **Harden** those captured flows into this server's `src/rednote.ts` (the `SEL` selectors and the
   step order), so you end up owning it end-to-end with no third-party dependency.

`START-HERE.md` orients an AI coding session picking this up. `PROTOTYPE-RUNSHEET.md` is the Phase-1
run sheet + capture template.

## What runs where

- This is a **local, stdio MCP server**. It runs on the same machine as your MCP client.
- Playwright needs a real browser (`npx playwright install chromium`). Run **headed** while verifying
  selectors (`RN_HEADLESS=0`), **headless** later (`RN_HEADLESS=1`).
- The login session is saved to `./.session/state.json` (Playwright `storageState`) and reused. **That
  file is a credential** — it's git-ignored; keep it off shared disks.

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env            # defaults are safe
npm run build

# One-time: log in (opens a browser; scan the QR with the account's phone)
npm run login

# Run the server (or let your MCP client launch it)
npm start
```

### Wire into Claude Desktop / Codex

```json
{
  "mcpServers": {
    "rednote": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/rednote-mcp/dist/index.js"],
      "env": { "RN_HEADLESS": "1" }
    }
  }
}
```

(Claude Code: `claude mcp add rednote -- node /ABSOLUTE/PATH/rednote-mcp/dist/index.js`.)

## Tools

| tool                    | kind      | status                                                                      |
| ----------------------- | --------- | --------------------------------------------------------------------------- |
| `rednote_login_status`  | read      | returns whether the saved session is logged in                              |
| `rednote_search`        | read      | implemented by reference — verify first                                     |
| `rednote_get_note`      | read      | implemented by reference — verify first                                     |
| `rednote_get_comments`  | read      | implemented by reference — verify first                                     |
| `rednote_create_post`   | **write** | flow written, **verify selectors**; photo note = title + body + image paths |
| `rednote_create_draft`  | **write** | same, stops at "save draft"                                                 |
| `rednote_post_comment`  | **write** | flow written, **verify selectors**                                          |
| `rednote_reply_comment` | **write** | flow written, **verify selectors**                                          |

Write tools default to **dry-run** (`RN_DRY_RUN=1`): they navigate and fill fields but do **not**
click the final publish/send button, logging what they _would_ do. Set `RN_DRY_RUN=0` only after you've
watched a headed dry run and confirmed every selector resolves.

## Anti-fragility notes

- **Human-like typing** (`typeHuman()` in `src/rednote.ts`): per-char delays + occasional pauses.
- **Concurrency 1** — never two actions at once on one session.
- **Rate limits** — space writes out; a burst of comments is the fastest route to a ban.
- Publishing goes through the **creator platform** (`creator.xiaohongshu.com`); reading/commenting is
  on `www.xiaohongshu.com`.

## License

MIT (your call when you open-source it). This is independent, unaffiliated software; "RedNote" and
"Xiaohongshu" are trademarks of their owner. For educational use; respect the platform's ToS and the
law in your jurisdiction.
