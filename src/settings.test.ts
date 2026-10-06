import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, MAX, loadSettings, saveSettings } from "./settings.js";

const file = () => join(mkdtempSync(join(tmpdir(), "rng-settings-")), "settings.json");

test("defaults are the cautious ones: dry run, 5 writes, 10 likes, 10 minutes between comments", () => {
  assert.deepEqual(loadSettings(file(), {}), DEFAULTS);
  assert.equal(DEFAULTS.dryRun, true);
});

test("environment variables apply when the settings file says nothing", () => {
  const s = loadSettings(file(), { RN_DAILY_WRITES: "3", RN_DRY_RUN: "0", RN_NOTIFY: "0" });
  assert.equal(s.daily, 3);
  assert.equal(s.dryRun, false);
  assert.equal(s.notify, false);
});

test("the settings file wins over environment variables", () => {
  const f = file();
  writeFileSync(f, JSON.stringify({ daily: 2, dryRun: true }));
  const s = loadSettings(f, { RN_DAILY_WRITES: "4", RN_DRY_RUN: "0" });
  assert.equal(s.daily, 2);
  assert.equal(s.dryRun, true);
});

test("nothing can go past the hard maximums, from the file or the environment", () => {
  const f = file();
  writeFileSync(f, JSON.stringify({ daily: 999, likes: 999, commentGapMin: 0 }));
  const s = loadSettings(f, {});
  assert.equal(s.daily, MAX.daily);
  assert.equal(s.likes, MAX.likes);
  assert.equal(s.commentGapMin, MAX.minCommentGapMin);
  assert.equal(loadSettings(file(), { RN_DAILY_WRITES: "500" }).daily, MAX.daily);
});

test("a corrupt settings file stops everything instead of falling back silently", () => {
  const f = file();
  writeFileSync(f, "{not json");
  assert.throws(() => loadSettings(f, {}), /settings\.json/);
});

test("saving checks every value and keeps the rest", () => {
  const f = file();
  saveSettings(f, { daily: 8, dryRun: false }, {});
  assert.deepEqual(JSON.parse(readFileSync(f, "utf8")), { daily: 8, dryRun: false });
  saveSettings(f, { likes: 20 }, {});
  assert.deepEqual(loadSettings(f, {}), { ...DEFAULTS, daily: 8, likes: 20, dryRun: false });
});

test("saving refuses values past the hard maximums or of the wrong type", () => {
  const f = file();
  assert.throws(() => saveSettings(f, { daily: 21 }, {}), /Writes per day/);
  assert.throws(() => saveSettings(f, { likes: -1 }, {}), /Likes per day/);
  assert.throws(() => saveSettings(f, { commentGapMin: 1 }, {}), /Minutes between comments/);
  assert.throws(() => saveSettings(f, { daily: 2.5 }, {}), /whole number/);
  assert.throws(() => saveSettings(f, { dryRun: "no" as unknown as boolean }, {}), /true or false/);
});
