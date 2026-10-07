# Security

## Reporting a vulnerability

Please report privately. Do not open a public issue.

Use GitHub's private vulnerability reporting. Go to the repo's **Security** tab and click **Report a vulnerability**.

Include what you found, how to reproduce it, and what an attacker could do. Do not include real session files, cookies or tokens.

## The session file is a credential

`~/.rednote-gate/.session/state.json` holds a logged-in RedNote session. A clone that had a login before 1.1 keeps it in `.session/state.json` inside the clone. Anyone with it can act as that account. Keep it out of git, issues, PRs, logs and screenshots. If it leaks, log out of RedNote on all devices and run `rednote-gate login` again.

## In scope

- The approval page: the Host header check, the approval token, and the same-origin check on POST.
- Queue path handling, such as a crafted ID that reads or writes outside the queue folder.
- Anything that could make a write happen without a human clicking Approve.
- Anything that could get around the daily write budget.

## Out of scope

- RedNote's own site or its anti-bot systems.
- Attacks that need an attacker already running code as your user on your machine.
