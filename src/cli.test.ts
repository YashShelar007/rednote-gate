import { test } from "node:test";
import assert from "node:assert/strict";
import { delimiter } from "node:path";
import { connectArgs, launchCommand, parseCli } from "./cli.js";

test("no arguments runs the MCP server, which is how MCP clients start it", () => {
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
