# Friction log

A dated log of anti-bot friction seen on RedNote: captchas, sliders, login walls, "too frequent" warnings, redirects. Newest entry at the bottom.

Add an entry every time something like this happens, even if it went away on its own. If rednote-gate halted, copy the `blocked` line from `data/ledger.jsonl` into the entry. If you changed code because of it, say what.

Template:

```
## YYYY-MM-DD: short title

- Where: the URL or page
- Account state: logged in or logged out
- How observed: rednote-gate tool, or another tool
- What happened:
- What worked instead:
- Ledger line: (if rednote-gate halted)
- Effect on code or process:
```

## 2026-10-06: bare note URL leads to a captcha

- Where: a note page, `https://www.xiaohongshu.com/explore/<id>` with no `xsec_token`
- Account state: logged out
- How observed: Firecrawl's scraper, not rednote-gate
- What happened: the bare note URL redirected to `/404` with `error_code=300031`. The page showed a slider captcha titled "Security Verification", with the prompt 拖动箭头完成拼图.
- What worked instead: the same note with its `xsec_token` was readable while logged out.
- Also seen: the search page, logged out, showed only a login wall.
- Ledger line: none. rednote-gate was not involved.
- Effect on code or process: note URLs must carry `xsec_token`. rednote-gate refuses bare note URLs before the browser opens. Take note URLs from `rednote_search` results.

## 2026-10-06: logged-out local browser is sent to the login page

- Where: the same note page, with its `xsec_token`, opened by rednote-gate's own Playwright Chromium (headless) from a home connection
- Account state: logged out, no saved session
- How observed: a one-page probe of `getNote`, no account involved
- What happened: RedNote redirected to `/login` and showed the QR login wall. `__INITIAL_STATE__.note.noteDetailMap` held only a placeholder keyed `"undefined"`. Firecrawl, fetching the same url from its servers, had been served the note.
- Ledger line: none. Not a captcha, so no halt.
- Effect on code or process: `open()` now recognises a redirect to `/login` and says "not logged in, run `npm run login`" instead of a misleading layout error. Note reads can only be verified after login.

## 2026-10-06: hidden decoy buttons on the creator publish page

- Where: `creator.rednote.com/publish/publish`, logged in
- How observed: rednote-gate's own publish dry run
- What happened: the page holds a second, hidden copy of the 上传图文 tab: `aria-hidden="true"`, `tabindex="-1"`, `data-hp-kind="creator-tab-上传图文"`, `button-hp-installed="1"`. The real tab sits on top of it. A selector that takes the first match picks the decoy. Playwright's click check refused to click it (the real tab intercepts the pointer), so the run timed out instead of clicking it.
- Ledger line: none. Dry run, run directly while verifying selectors.
- Effect on code: every clickable selector in `SEL` now excludes `aria-hidden` and `data-hp-*` elements. rednote-gate acts only on what a person can see and click, and never uses forced clicks.

## 2026-10-06: the final buttons live in one closed shadow-DOM element

- Where: the same page, after an image upload
- What happened: 暂存离开 and 发布 are both inside one `<xhs-publish-btn>` element with closed shadow DOM. Its attributes name the buttons (`submit-text="发布"`, `save-text="暂存离开"`, `submit-disabled`, `save-disabled`). The element's centre falls in the gap between the two buttons.
- Effect on code: rednote-gate checks those attributes, then clicks 72px left (暂存离开) or right (发布) of the centre. If the labels change, it stops instead of clicking.

## 2026-10-06: the topic picker needs time

- Where: the creator publish page body, rednote.com account
- What happened: typing `#name` opens a picker that loads for 1 to 2 seconds, then offers `#name 新建话题` (on this overseas account, only that entry, even for common topics). Clicking it turns the text into a linked topic (`#name[话题]#` in the editor). Typing the next `#` while the previous picker was still closing lost characters: `#自习` became `习`.
- Effect on code: rednote-gate waits for the exact entry (up to 6 seconds), pauses after `#` and between topics, and the body read-back refused the mangled text before any click.
