#!/usr/bin/env node
// The `rednote-gate` command. No arguments runs the MCP server, which is what MCP clients start.
// Subcommands set it up and look after it. None of them contacts RedNote except `login` and `setup`.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { statusLines, usage } from "./help.js";
import { haltReason, readLedger } from "./ledger.js";
import { saveSettings } from "./settings.js";
import { DATA, LEDGER, SETTINGS_FILE, VERSION, current, limitsOf, probeService } from "./config.js";
import { DATA_DIR, HOME, SESSION_PATH, alive, hasSavedSession, site } from "./session.js";

const COMMANDS = ["setup", "login", "connect", "live", "dry", "stop", "approve", "status", "doctor", "help"] as const;
export type Command = (typeof COMMANDS)[number] | "serve";

/** Strict on purpose: a typo must never fall through to starting the server or going live. */
export function parseCli(argv: string[]): { command: Command; yes: boolean } {
  const flags = argv.filter((a) => a.startsWith("-"));
  const words = argv.filter((a) => !a.startsWith("-"));
  const bad = flags.find((f) => !["--yes", "-y", "--help", "-h"].includes(f));
  if (bad) throw new Error(`Unknown option ${bad}.`);
  if (flags.includes("--help") || flags.includes("-h")) return { command: "help", yes: false };
  if (words.length > 1) throw new Error(`One command at a time, got "${words.join(" ")}".`);
  const command = (words[0] ?? "serve") as Command;
  if (command !== "serve" && !(COMMANDS as readonly string[]).includes(command)) throw new Error(`Unknown command "${command}".`);
  const yes = flags.includes("--yes") || flags.includes("-y");
  if (yes && command !== "live") throw new Error("--yes only goes with live.");
  return { command, yes };
}

/** `rednote-gate` if PATH finds this very install (a global install or npm link), else node and the absolute path. */
export function launchCommand(cli: string, pathEnv: string, real: (p: string) => string | null): string[] {
  const self = real(cli);
  const onPath = pathEnv.split(delimiter).some((dir) => dir && real(join(dir, "rednote-gate")) === self);
  return onPath ? ["rednote-gate"] : ["node", cli];
}

/** `claude mcp add` reads -e as a list, so the name goes first and the command after --. */
export function connectArgs(launch: string[], env: Record<string, string>): string[] {
  const e = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  return ["mcp", "add", "rednote-gate", "--scope", "user", ...e, "--", ...launch];
}

const CLI = fileURLToPath(import.meta.url);
const realOrNull = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};
const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: "inherit" }).status === 0;

const HELP = `rednote-gate ${VERSION}: an MCP server for one throwaway RedNote account. Every write waits for your Approve click.

Usage: rednote-gate [command]

  (none)       run the MCP server on stdio (this is what MCP clients start)
  setup        install Chromium, log in, then connect
  login        QR login for the throwaway account
  connect      add rednote-gate to Claude Code; print config for Claude Desktop and Codex
  live --yes   approved items are published (without --yes it asks first)
  dry          approved items fill the form but never publish (the default)
  stop         stop the background service
  approve      print the approval page link
  status       version, site, mode, today's budget, service
  doctor       offline checks; never contacts RedNote
  help         this text

Data and login: ${HOME} (set RN_HOME to move them).`;

/** Values a client must also see, made absolute because MCP clients start us in another folder. */
function passEnv(): Record<string, string> {
  const set = { RN_HOME: HOME, RN_DATA_DIR: DATA_DIR, RN_SESSION_PATH: SESSION_PATH };
  return Object.fromEntries(Object.entries(set).filter(([k]) => process.env[k]).map(([k, v]) => [k, resolve(v)]));
}

function connect(): boolean {
  const launch = launchCommand(CLI, process.env.PATH ?? "", realOrNull);
  const env = passEnv();
  const got = spawnSync("claude", ["mcp", "get", "rednote-gate"], { stdio: "ignore" });
  let ok = true;
  if (got.error) console.log("Claude Code CLI not found. Add rednote-gate to your client by hand:");
  else if (got.status === 0) console.log('rednote-gate is already connected to Claude Code. To re-add it, run "claude mcp remove rednote-gate -s user" first.');
  else if ((ok = run("claude", connectArgs(launch, env)))) console.log("Connected to Claude Code for all your projects. Open a new Claude Code session.");
  const desktop = { mcpServers: { "rednote-gate": { command: launch[0], args: launch.slice(1), ...(Object.keys(env).length && { env }) } } };
  const toml = Object.entries(env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`);
  console.log(`
Claude Desktop (claude_desktop_config.json):
${JSON.stringify(desktop, null, 2)}

Codex (~/.codex/config.toml):
[mcp_servers.rednote-gate]
command = ${JSON.stringify(launch[0])}
args = ${JSON.stringify(launch.slice(1))}${toml.length ? `\nenv = { ${toml.join(", ")} }` : ""}`);
  return ok;
}

/** The lock holds the pid of whoever drives the browser: the service, or a login. */
function lockPid(): number | null {
  try {
    const pid = Number(readFileSync(join(DATA, "lock"), "utf8"));
    return Number.isInteger(pid) && pid > 1 && pid !== process.pid && alive(pid) ? pid : null;
  } catch {
    return null;
  }
}
/** Never signal a pid we cannot show is the service: a stale lock may name someone else's process. */
function isService(pid: number): boolean {
  if (process.platform === "win32") return true; // ponytail: no ps on Windows; trusts the lock there
  const ps = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  return ps.status === 0 && ps.stdout.includes("service.js");
}

async function stop(): Promise<boolean> {
  const pid = lockPid();
  if (!pid) return console.log("The rednote-gate service is not running."), true;
  if (!isService(pid)) return console.log(`The lock belongs to pid ${pid}, which is not the rednote-gate service (a login, or a stale lock). Not stopping it.`), false;
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  console.log(`Stopped the rednote-gate service (pid ${pid}).`);
  return true;
}

async function ask(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return console.error('No terminal to ask in. Run "rednote-gate live --yes" to confirm.'), false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function setMode(live: boolean, yes: boolean): Promise<boolean> {
  if (live) {
    console.log("Live mode: each item you approve is published, sent or liked from the RedNote account. Nothing goes out without your Approve click. Approvals given in dry run do not run live.");
    if (!yes && !(await ask("Switch to live? [y/N] "))) return console.log("Still in dry run."), false;
  }
  mkdirSync(DATA, { recursive: true, mode: 0o700 });
  const s = saveSettings(SETTINGS_FILE, { dryRun: !live });
  console.log(s.dryRun ? "rednote-gate is in dry run: approved items fill the form but never publish." : "rednote-gate is LIVE: approved items will be published.");
  return stop();
}

async function status(): Promise<boolean> {
  const s = current();
  const login = hasSavedSession() ? `saved (${site()})` : 'none yet. Run "rednote-gate login".';
  const up = await probeService();
  const pid = lockPid();
  console.log(
    [
      ...statusLines({ version: VERSION, site: site(), dryRun: s.dryRun, limits: limitsOf(s), ...usage(readLedger(LEDGER), limitsOf(s), new Date()) }),
      `Login: ${login}`,
      `Service: ${up ? `running on ${up.url.origin}${pid ? `, pid ${pid}` : ""}` : "not running. It starts with the first rednote tool call."}`,
      `Data: ${DATA}`,
    ].join("\n"),
  );
  return true;
}

async function doctor(): Promise<boolean> {
  const checks: [string, () => string | Promise<string>][] = [
    ["Node 20 or newer", () => {
      if (Number(process.versions.node.split(".")[0]) < 20) throw new Error(`Node ${process.versions.node}. Install Node 20 or newer.`);
      return `Node ${process.versions.node}`;
    }],
    ["Chromium installed", async () => {
      const path = (await import("playwright")).chromium.executablePath();
      if (!existsSync(path)) throw new Error('not found. Run "rednote-gate setup", or "npx playwright install chromium" in a clone.');
      return path;
    }],
    ["Login saved", () => {
      if (!hasSavedSession()) throw new Error(`none at ${SESSION_PATH}. Run "rednote-gate login".`);
      return `${site()}, ${SESSION_PATH}`;
    }],
    ["Settings valid", () => {
      const s = current();
      return `${s.dryRun ? "dry run" : "LIVE"}, ${s.daily} writes and ${s.likes} likes a day, comments ${s.commentGapMin} minutes apart`;
    }],
    ["Ledger readable", () => {
      const entries = readLedger(LEDGER);
      const halt = haltReason(entries);
      if (halt) throw new Error(`halted after RedNote showed: ${halt}. Check the account, then press Resume on the approval page.`);
      return `${entries.length} lines, not halted`;
    }],
    ["Service", async () => {
      const up = await probeService();
      if (up) return `running on ${up.url.origin}`;
      const pid = lockPid();
      if (pid && isService(pid)) throw new Error(`pid ${pid} holds the lock but its page does not answer. Run "rednote-gate stop".`);
      return "not running. It starts with the first rednote tool call.";
    }],
  ];
  let ok = true;
  for (const [name, check] of checks) {
    try {
      console.log(`PASS  ${name}: ${await check()}`);
    } catch (e) {
      ok = false;
      console.log(`FAIL  ${name}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return ok;
}

const LOGIN = fileURLToPath(new URL("./login.js", import.meta.url));

async function main(argv: string[]): Promise<number | undefined> {
  let cmd: ReturnType<typeof parseCli>;
  try {
    cmd = parseCli(argv);
  } catch (e) {
    console.error(`${(e as Error).message} Run "rednote-gate help".`);
    return 2;
  }
  const done = (ok: boolean) => (ok ? 0 : 1);
  switch (cmd.command) {
    case "serve":
      await import("./index.js"); // stdout now belongs to MCP: print nothing here
      return undefined;
    case "setup": {
      const playwright = join(dirname(createRequire(import.meta.url).resolve("playwright/package.json")), "cli.js");
      if (!run(process.execPath, [playwright, "install", "chromium"])) return 1;
      if (!run(process.execPath, [LOGIN])) return 1;
      return done(connect());
    }
    case "login":
      return done(run(process.execPath, [LOGIN]));
    case "connect":
      return done(connect());
    case "live":
    case "dry":
      return done(await setMode(cmd.command === "live", cmd.yes));
    case "stop":
      return done(await stop());
    case "approve": {
      const up = await probeService();
      if (!up) return console.error("The approval page is not running. It starts with the first rednote tool call."), 1;
      console.log(up.url.toString());
      return 0;
    }
    case "status":
      return done(await status());
    case "doctor":
      return done(await doctor());
    case "help":
      console.log(HELP);
      return 0;
  }
}

// Run only as the program, not when a test imports this file. npm's bin link resolves to this file.
if (process.argv[1] && realOrNull(process.argv[1]) === CLI) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code !== undefined) process.exitCode = code;
    },
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    },
  );
}
