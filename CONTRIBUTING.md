# Contributing

Thanks for helping. This is a small project. Keep changes small too.

## Setup

You need Node 20 or newer.

```sh
npm install
npx playwright install chromium
npm run build
npm test
```

Tests use Node's built-in runner. They do not need a browser or a network.

## Fixing a broken selector

RedNote changes its pages. When a flow breaks, it is almost always a selector.

1. Find the selector in the `SEL` object in `src/rednote.ts`. All selectors live there. Change it there only.
2. Run the flow headed with a dry run. Leave `RN_HEADLESS` unset so the window shows. Run `npm run dry` first so the final button is not clicked. The mode saved in `settings.json` wins over `RN_DRY_RUN`. Watch it work.
3. Fill the capture block in `PROTOTYPE-RUNSHEET.md` for that flow.
4. If you hit a captcha, a "too frequent" warning or any other friction, add a dated line to `docs/friction.md`.
5. Open a PR. Paste the capture block, or describe what you saw, as evidence.

## Tests

Logic changes to the queue, ledger, budget, worker or approval page need tests.

Tests must not need a browser or a network. If your test needs one, the logic is in the wrong place. Pull it out into a plain function and test that.

## Pull requests

- One change per PR. Say what changed and why.
- `npm test` passes.
- Update `README.md` if behaviour changed.
- Fill in the PR template.

## PRs that will be closed

This tool is safe because of its limits. These PRs will be closed:

- Removing or bypassing the human approval gate.
- Multi-account support.
- Bulk or unattended posting.
- Captcha solving.
- New anti-detection or fingerprint evasion.
- Raising the default budget.

## Never share secrets

Never paste session files, cookies, tokens or screenshots that show personal data into an issue or PR. The file `.session/state.json` is a login credential. Treat it like a password. Redact screenshots before you share them.
