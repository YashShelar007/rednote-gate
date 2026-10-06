# START HERE — for the coding session picking this up

You're building **rednote-mcp**: a local MCP server that lets an MCP client (Claude/Codex) drive a
RedNote (Xiaohongshu) account — search/read, and create posts, drafts, comments, replies — via
Playwright, because RedNote has no official write API.

## State of this repo

A **working scaffold**, not a finished product:

- `src/index.ts` — MCP stdio server, registers all 8 tools. **Done.**
- `src/session.ts` — Playwright browser + persisted login (`storageState`). **Done.**
- `src/login.ts` — one-time interactive QR login (`npm run login`). **Done.**
- `src/rednote.ts` — the automation flows. **Structure done; the DOM selectors in the `SEL` object
  are educated guesses and must be verified against the live site.** This is the real work.

Everything compiles and the read tools should mostly work; the write flows (publish/draft/comment/
reply) are written by reference and gated behind `RN_DRY_RUN=1` until verified.

## Your job, in order

1. **Prototype to discover the truth.** Follow `PROTOTYPE-RUNSHEET.md`: connect the client to
   Microsoft's `@playwright/mcp`, log in to the dedicated account, and run the test ladder headed.
   For each flow, record the exact pages, element labels/roles, and waits (capture template is in that
   file). This is how you learn what RedNote actually requires without guessing.
2. **Harden into `src/rednote.ts`.** Replace each `VERIFY` selector in `SEL` with what the prototype
   showed, and fix the step order / waits in each flow to match. Keep the dry-run gate, `typeHuman()`,
   concurrency 1, and session persistence.
3. **Turn on writes carefully.** Verify headed with `RN_DRY_RUN=1` (fields fill, nothing sends), watch
   it, then `RN_DRY_RUN=0` for one real action at a time: publish → draft → comment → reply.
4. **Then grow it** ("even more"): list my drafts, basic analytics on my own notes (likes/saves/
   comments), scheduled/unattended posting (that's where a model-free deterministic path matters).

## The one rule that matters most

Use a **dedicated throwaway account**. This automates RedNote against its ToS; the account can be
banned. Never point it at a primary/brand account. Space out writes. Run headed until you trust it.

## Acceptance test

Each flow is "done" when it works **unattended** (no human clicking) against the live site from a
cold start (fresh `npm start`, saved session), headless, with the selector centralised in `SEL`.
