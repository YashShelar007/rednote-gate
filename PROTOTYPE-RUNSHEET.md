# RedNote MCP — Hybrid plan run sheet

**Plan:** prototype on Microsoft's Playwright MCP to discover the real flows, then harden them into
this repo's own end-to-end server (`src/`). All of Phase 1 runs on **your local machine** with a
**dedicated** RedNote account.

The point of Phase 1 is NOT the posts — it's the **capture** at the bottom. Each flow Claude gets
working, you record, and that recording is what our own server implements without guessing.

---

## Phase 0 — prerequisites (once)

1. **Dedicated RedNote account.** Sign up in the RedNote phone app. This is the account whose ban
   risk you've accepted — never a primary/brand account. Keep the phone next to you for the QR login.
2. **Local machine with Node 18+** and your Claude Code / Codex client.

## Phase 1 — prototype with Microsoft's Playwright MCP (you + Claude, headed)

```bash
npx playwright install chromium

# Pin the version (it's 0.0.x and changes weekly). Persistent profile = stay logged in.
claude mcp add rednote -- npx @playwright/mcp@0.0.83 --user-data-dir ~/.rednote-profile --browser chromium
# (Codex: put the same command/args in its MCP config. Verify flags: npx @playwright/mcp@0.0.83 --help)
```

**One-time login:** tell Claude _"open xiaohongshu.com"_, scan the QR with the dedicated account's
phone. The `--user-data-dir` profile keeps you logged in after that. That folder is now a credential.

**Test ladder — do these in order, headed, watching the window. Do not skip ahead.**

| #   | Prompt to Claude                                                                                                      | What you're checking         |
| --- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 1   | "search RedNote for 奖学金 and summarise the top 5 notes"                                                             | read path works; login holds |
| 2   | "open this note <url> and list its comments"                                                                          | read a note + comments       |
| 3   | "go to the publish page, fill a title and body about X, add this image — but DO NOT click 发布; show me what you see" | the write form, dry          |
| 4   | (after watching #3) "now publish it"                                                                                  | first real post              |
| 5   | "save a post about Y as a draft (don't publish)"                                                                      | draft flow                   |
| 6   | "post this comment on note <url>: …"                                                                                  | comment                      |
| 7   | "reply to the 2nd comment on note <url> with: …"                                                                      | reply                        |

Space these out. A burst of writes is the fastest way to a limit or ban.

---

## The capture — fill one block per working flow (this is the spec for Phase 2)

For each of search / get-note / get-comments / create-post / create-draft / comment / reply:

```
FLOW: <name>
START URL: <where it begins, e.g. creator.xiaohongshu.com/publish/publish>
STEPS (in order, as Claude actually did them):
  1. <action> on element labelled "<visible text / role>"   e.g. click button "发布"
  2. type into field labelled "<...>"
  3. wait for "<...>" to appear
  ...
WHAT SUCCEEDED: <the post/comment appeared? where?>
WAITS THAT MATTERED: <uploads need N seconds? a spinner to clear?>
ANTI-BOT / FRICTION: <captcha? slider? "operation too frequent"? login re-prompt?>
RATE LIMIT HIT AT: <if any — e.g. 3rd comment in a minute>
```

Claude can produce most of this itself — ask it: _"for the flow you just did, write out the exact
ordered steps and the label/role of each element you acted on, in the capture format."_

---

## Phase 2 — harden into this repo's own server (from your captures)

Once the captures are in, we implement the proven flows in this folder's `src/rednote.ts` (the
scaffold is already built for it — `SEL`, `typeHuman`, dry-run, session persistence), you run **ours**
locally the same way, and when it matches the prototype we drop Microsoft's MCP. Our server is then
end-to-end ours, and can later grow the unattended/scheduled layer.

**Timing:** Phase 1 is a local, interactive loop. Phase 2 is ordinary coding from the captures.
