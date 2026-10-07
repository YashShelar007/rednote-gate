import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { resolveHome } from "./home.js";

const ROOT = "/opt/pkg/rednote-gate";
const USER = "/Users/someone";
const none = () => false;
const cloneLogin = (p: string) => p === join(ROOT, ".session");

test("a fresh install keeps data and login in ~/.rednote-gate", () => {
  assert.deepEqual(resolveHome({}, ROOT, USER, none), {
    home: join(USER, ".rednote-gate"),
    dataDir: join(USER, ".rednote-gate", "data"),
    sessionPath: join(USER, ".rednote-gate", ".session", "state.json"),
  });
});

test("a clone that already has .session/ keeps using its own folder", () => {
  const p = resolveHome({}, ROOT, USER, cloneLogin);
  assert.equal(p.home, ROOT);
  assert.equal(p.dataDir, join(ROOT, "data"));
  assert.equal(p.sessionPath, join(ROOT, ".session", "state.json"));
});

test("RN_HOME wins over both, and a relative RN_HOME becomes absolute", () => {
  assert.equal(resolveHome({ RN_HOME: "/tmp/rg" }, ROOT, USER, cloneLogin).dataDir, join("/tmp/rg", "data"));
  assert.equal(resolveHome({ RN_HOME: "rg" }, ROOT, USER, none).home, resolve("rg"));
});

test("RN_DATA_DIR and RN_SESSION_PATH still override their own path", () => {
  const p = resolveHome({ RN_HOME: "/tmp/rg", RN_DATA_DIR: "/d", RN_SESSION_PATH: "/s/state.json" }, ROOT, USER, none);
  assert.equal(p.home, "/tmp/rg");
  assert.equal(p.dataDir, "/d");
  assert.equal(p.sessionPath, "/s/state.json");
});

test("an empty RN_HOME counts as unset", () => {
  assert.equal(resolveHome({ RN_HOME: "" }, ROOT, USER, none).home, join(USER, ".rednote-gate"));
});
