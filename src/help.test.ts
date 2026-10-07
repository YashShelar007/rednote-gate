import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CATALOGUE, helpText, usage } from "./help.js";

const source = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
const registered = (kind: "Tool" | "Prompt") => [...source("index.ts").matchAll(new RegExp(`register${kind}\\(\\s*"([a-z_]+)"`, "g"))].map((m) => m[1]);

test("help lists exactly the tools the server registers", () => {
  assert.deepEqual(CATALOGUE.tools.map((t) => t.name).sort(), registered("Tool").sort());
});

test("help lists exactly the workflows the server registers", () => {
  assert.deepEqual(CATALOGUE.workflows.map((w) => w.name).sort(), registered("Prompt").sort());
});

test("help shows the mode and what is left of today's budget", () => {
  const text = helpText({ version: "1.0.0", site: "rednote.com", dryRun: false, writesUsed: 5, likesUsed: 1, limits: { daily: 5, commentGapMin: 10, likes: 10 }, nextWrite: "Oct 7, 2:57 PM" });
  assert.match(text, /LIVE/);
  assert.match(text, /0 of 5 writes left/);
  assert.match(text, /next at Oct 7, 2:57 PM/);
  assert.match(text, /9 of 10 likes left/);
  assert.match(text, /rednote_create_post/);
  assert.match(helpText({ version: "1.0.0", site: "xiaohongshu.com", dryRun: true, writesUsed: 0, likesUsed: 0, limits: { daily: 5, commentGapMin: 10 } }), /DRY RUN/);
});

test("usage counts live writes and likes from the last 24 hours only", () => {
  const now = new Date("2026-10-07T12:00:00Z");
  const at = (h: number) => new Date(now.getTime() - h * 3600_000).toISOString();
  const entries = [
    { at: at(1), event: "attempt" as const, tool: "create_post" as const, dryRun: false },
    { at: at(2), event: "attempt" as const, tool: "post_comment" as const, dryRun: false },
    { at: at(3), event: "attempt" as const, tool: "like_note" as const, dryRun: false },
    { at: at(4), event: "attempt" as const, tool: "create_post" as const, dryRun: true },
    { at: at(30), event: "attempt" as const, tool: "create_post" as const, dryRun: false },
  ];
  const u = usage(entries, { daily: 5, commentGapMin: 10 }, now);
  assert.equal(u.writesUsed, 2);
  assert.equal(u.likesUsed, 1);
  assert.equal(u.nextWrite, undefined);
  assert.ok(usage(entries, { daily: 2, commentGapMin: 10 }, now).nextWrite, "no write left, so it says when the next one opens");
});

test("both writing workflows set the AI label, because Claude writes the text in both", () => {
  const prompts = source("index.ts").split("server.registerPrompt(").slice(1);
  for (const name of ["post_photos", "post_from_concept"]) {
    const p = prompts.find((x) => x.includes(`"${name}"`));
    assert.match(p ?? "", /aiGenerated: true/, name);
  }
});

test("the MCP Registry entry matches the npm package it points to", () => {
  const pkg = JSON.parse(source("../package.json"));
  const entry = JSON.parse(source("../server.json"));
  assert.equal(entry.name, pkg.mcpName);
  assert.equal(entry.version, pkg.version);
  assert.deepEqual(entry.packages.map((p: { identifier: string; version: string }) => [p.identifier, p.version]), [[pkg.name, pkg.version]]);
  assert.ok(entry.description.length <= 100, "the registry allows 100 characters");
});
