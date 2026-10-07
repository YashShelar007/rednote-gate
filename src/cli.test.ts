import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApproval } from "./approval.js";
import { connectArgs, launchCommand, parseCli } from "./cli.js";

test("no arguments runs the MCP server, which is how MCP hosts start it", () => {
  assert.deepEqual(parseCli([]), { command: "serve", yes: false });
});

test("each subcommand parses to itself", () => {
  for (const c of ["setup", "login", "connect", "live", "dry", "stop", "approve", "status", "doctor", "help"]) {
    assert.equal(parseCli([c]).command, c);
  }
});

test("live takes --yes or -y", () => {
  assert.deepEqual(parseCli(["live", "--yes"]), { command: "live", yes: true });
  assert.deepEqual(parseCli(["-y", "live"]), { command: "live", yes: true });
  assert.deepEqual(parseCli(["live"]), { command: "live", yes: false });
});

test("--yes anywhere but live is refused, so it can never start the server by accident", () => {
  assert.throws(() => parseCli(["--yes"]), /--yes only goes with live/);
  assert.throws(() => parseCli(["dry", "--yes"]), /--yes only goes with live/);
});

test("--help and -h show help", () => {
  assert.equal(parseCli(["--help"]).command, "help");
  assert.equal(parseCli(["status", "-h"]).command, "help");
});

test("unknown commands, unknown options and extra words are refused", () => {
  assert.throws(() => parseCli(["publish"]), /Unknown command "publish"/);
  assert.throws(() => parseCli(["status", "--force"]), /Unknown option --force/);
  assert.throws(() => parseCli(["live", "now"]), /One command at a time/);
});

test("connect uses the rednote-gate command when PATH finds this same install", () => {
  const cli = "/prefix/lib/node_modules/rednote-gate/dist/cli.js";
  const links: Record<string, string> = { [cli]: cli, "/prefix/bin/rednote-gate": cli };
  const real = (p: string) => links[p] ?? null;
  assert.deepEqual(launchCommand(cli, ["/usr/bin", "/prefix/bin"].join(delimiter), real), ["rednote-gate"]);
});

test("connect falls back to node and the absolute path otherwise", () => {
  const cli = "/home/me/rednote-gate/dist/cli.js";
  const links: Record<string, string> = { [cli]: cli, "/usr/local/bin/rednote-gate": "/other/install/dist/cli.js" };
  const real = (p: string) => links[p] ?? null;
  assert.deepEqual(launchCommand(cli, "/usr/local/bin", real), ["node", cli]);
  assert.deepEqual(launchCommand(cli, "", real), ["node", cli]);
});

test("claude mcp add gets the name before any -e, then the command after --", () => {
  assert.deepEqual(connectArgs(["rednote-gate"], {}), ["mcp", "add", "rednote-gate", "--scope", "user", "--", "rednote-gate"]);
  assert.deepEqual(connectArgs(["node", "/x/dist/cli.js"], { RN_HOME: "/tmp/rg" }), [
    "mcp", "add", "rednote-gate", "--scope", "user", "-e", "RN_HOME=/tmp/rg", "--", "node", "/x/dist/cli.js",
  ]);
});

/** The built command, in its own temp home, so the owner's real data is never read or written. */
const CLI = fileURLToPath(new URL("./cli.js", import.meta.url));
function runCli(args: string[], port: number): Promise<{ code: number; out: string; home: string }> {
  const home = mkdtempSync(join(tmpdir(), "rng-cli-"));
  const env = { PATH: process.env.PATH ?? "", HOME: home, RN_HOME: home, RN_APPROVAL_PORT: String(port), RN_NOTIFY: "0" };
  return new Promise((resolve) =>
    execFile(process.execPath, [CLI, ...args], { env, timeout: 20_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? Number(err.code) || 1 : 0, out: stdout + stderr, home }),
    ),
  );
}
const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

test("live and dry refuse when the running service uses another home, instead of saying a mode it does not run", async (t) => {
  const other = mkdtempSync(join(tmpdir(), "rng-other-"));
  const { server, port } = await startApproval({ dir: join(other, "queue"), ledger: join(other, "ledger.jsonl"), token: "c".repeat(48), port: 0, limits: { daily: 5, commentGapMin: 10 }, dryRun: false });
  t.after(() => server.close());
  for (const args of [["dry"], ["live", "--yes"]]) {
    const r = await runCli(args, port);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.out, /different data folder/);
    assert.equal(existsSync(join(r.home, "data", "settings.json")), false, "nothing written where the service never reads it");
  }
  for (const args of [["status"], ["stop"]]) assert.match((await runCli(args, port)).out, /different data folder/, args.join(" "));
});

test("with no service running, dry saves the mode and says where", async () => {
  const r = await runCli(["dry"], await freePort());
  assert.equal(r.code, 0, r.out);
  const file = join(r.home, "data", "settings.json");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).dryRun, true);
  assert.match(r.out, new RegExp(`Saved in ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});
