# Spec: the next four capabilities (2026-10-06)

Every write below goes through the same queue, approval page, budget, captcha halt and ledger. Nothing reaches RedNote without a human click on Approve.

## Capability map

| Module id | Responsibility | Depends on |
| --- | --- | --- |
| `topics` | Real RedNote topics (#话题) and emoji in post bodies | publish flow |
| `likes` | Like a note, after approval | note page, budget |
| `cards` | Render text-card images locally (no RedNote, no AI), for notes without photos | none |
| `concept` | Workflow: concept to research to note to cards to queue | `cards`, `topics` |
| `video` | Publish a video note, after approval | publish flow |

Build order: `topics`, `likes` (small, risk-first) in parallel with `cards` (separate agent, separate file), then `concept`, then `video`.

## Assumptions

1. Topics go in a separate `topics` list (max 5, no `#`). A `#` inside the body is refused, because the topic picker can change the text. Emoji are allowed in the body if a dry run shows the read-back still matches.
2. Likes have their own daily cap (`RN_DAILY_LIKES`, default 10, owner decision 2026-10-06) and do not use the 5 writes. Same approval page. It refuses if the note is already liked, and it reads the liked state back after the click.
3. Cards are 1080x1440 PNGs (RedNote's 3:4), rendered from text by a headless browser that never opens RedNote. No new dependency. Escaped text, network blocked.
4. Video: one MP4 or MOV per note, checked by file signature, a 500 MB project limit, copied into the queue and hashed like images. The approval page plays it.
5. The likes reversal of the original brief is recorded in the README.

## Success criteria

- `topics`: a dry run with 2 topics and an emoji passes the read-back; one live post shows linked topics.
- `likes`: a dry run finds the like button; one live like on a note, verified by the liked state.
- `cards`: unit tests for escaping and sizing; a rendered card looks right by eye in light text on a solid background.
- `concept`: the workflow queues a post whose images are generated cards.
- `video`: a dry run with a generated test video reaches the 发布 button; one live video post later, approved by the owner.

## Boundaries

- Always: test first, dry run on the live site before any live write, one browser on the account.
- Ask first: raising limits, anything that posts without approval (never), new dependencies.
- Never: like or comment in bulk, solve captchas, click hidden decoy elements.
