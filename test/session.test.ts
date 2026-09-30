import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { parentSessionContainsChildResult } from "../pi-extension/subagents/session.ts";

function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "subagent-result-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("recognizes a persisted appendCustomMessageEntry result without a role", t => {
  const dir = fixture(t);
  const manager = SessionManager.create(dir, join(dir, "sessions"));
  manager.appendMessage({ role: "user", content: "task", timestamp: 1 });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "ready" }], timestamp: 2,
    provider: "test", api: "test", model: "test", stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  manager.appendCustomMessageEntry("subagent_result", "done", true, { id: "child-1" });
  const sessionFile = manager.getSessionFile()!;
  const entry = JSON.parse(readFileSync(sessionFile, "utf8").trim().split("\n").at(-1)!);
  assert.equal(entry.type, "custom_message");
  assert.equal(entry.role, undefined);
  assert.equal(entry.message, undefined);
  assert.deepEqual(entry.details, { id: "child-1" });
  assert.equal(parentSessionContainsChildResult(sessionFile, "child-1"), true);
  assert.equal(parentSessionContainsChildResult(sessionFile, "child-2"), false);
});

test("preserves nested and top-level legacy custom result messages", t => {
  const sessionFile = join(fixture(t), "parent.jsonl");
  const message = { role: "custom", customType: "subagent_result", details: { id: "child-1" } };
  for (const entry of [{ type: "message", message }, message]) {
    writeFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
    assert.equal(parentSessionContainsChildResult(sessionFile, "child-1"), true);
    assert.equal(parentSessionContainsChildResult(sessionFile, "child-2"), false);
  }
});

test("does not infer delivery from unrelated entries, names, or missing child ids", t => {
  const sessionFile = join(fixture(t), "parent.jsonl");
  assert.equal(parentSessionContainsChildResult(sessionFile, "child-1"), false);
  const result = { type: "custom_message", customType: "subagent_result", details: { id: "child-1" } };
  const entries = [
    { ...result, customType: "other_result" },
    { ...result, details: { id: "child-10", name: "child-1" } },
    { ...result, details: { name: "child-1" } },
    { ...result, details: null },
    { ...result, type: "custom", data: result.details },
    { ...result, type: "message", message: { role: "user", customType: result.customType, details: result.details } },
    { customType: result.customType, details: result.details },
  ];
  writeFileSync(sessionFile, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\nnot-json\n`);
  assert.equal(parentSessionContainsChildResult(sessionFile, "child-1"), false);
});
