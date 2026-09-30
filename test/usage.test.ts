import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import subagents, { __test__ as integration } from "../pi-extension/subagents/index.ts";
import { captureChildUsage, childUsageDetails, preloadUsageCollector, readUsageDescriptor, reconcileChildUsage, registerChildUsage, usageDescriptorPath } from "../pi-extension/subagents/usage.ts";
import { childLifecyclePath, deleteDeliveredSubagentSession, getSessionId, listChildLifecycleRecords, readChildLifecycleRecord, readNameRegistry, registerName, seedSubagentSessionFile, updateChildLifecycleRecord, writeChildLifecycleRecord, writeSubagentLoadout } from "../pi-extension/subagents/session.ts";
const getArtifactDir = (sessionDir: string, sessionId: string) => join(sessionDir, "artifacts", sessionId);

// Contract integration against the approved tracker, not a mocked cleanup/ledger implementation.
const trackerRoot = process.env.PI_USAGE_TEST_ROOT ?? "/home/ai001/.pi/profiles/herdr/.worktrees/feat-unified-usage-tracking/extensions/pi-usage";
const { UsageCollector, COLLECTOR_PATH, readChildDescriptor } = await import(pathToFileURL(join(trackerRoot, "collector.ts")).href);
const { SessionManager } = await import("@mariozechner/pi-coding-agent");
class Bus {
  handlers = new Map<string, any[]>();
  on(k: string, f: any) { const a = this.handlers.get(k) ?? []; a.push(f); this.handlers.set(k, a); return () => this.handlers.set(k, a.filter(x => x !== f)); }
  emit(k: string, v: any) { for (const f of this.handlers.get(k) ?? []) f(v); }
}
const response = (timestamp = 100, model = "model-one") => ({ role: "assistant", content: [{ type: "text", text: "PRIVATE ANSWER" }], timestamp, provider: "physical-provider", api: "physical-api", model, stopReason: "stop", usage: { input: 11, output: 3, cacheRead: 2, cacheWrite: 0, totalTokens: 16, cost: { total: 0.1 } } });
async function user(f: any, collector: any, manager: any, timestamp: number) {
  const message = { role: "user", content: "PRIVATE TASK", timestamp };
  collector.input({ text: message.content, source: "interactive" });
  await collector.messageStart(message); manager.appendMessage(message); await collector.collect();
}
async function assistant(collector: any, manager: any, timestamp = 100, model = "model-one", collect = false) {
  const message = response(timestamp, model);
  await collector.messageStart(message); collector.messageEnd(message); manager.appendMessage(message);
  if (collect) await collector.collect();
}
async function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "u5-"));
  const manager = SessionManager.create(dir, join(dir, "sessions"));
  manager.appendMessage({ role: "user", content: "OLD PRIVATE PREFIX", timestamp: 1 }); manager.appendMessage(response(2));
  const bus = new Bus(); const all: any[] = [];
  const options = { agentDir: dir, manager, events: bus, appendEntry: (k: string, d: any) => manager.appendCustomEntry(k, d), project: dir };
  const collector = await UsageCollector.start(options); all.push(collector);
  const f = { dir, manager, bus, options, collector, all, ctx: { sessionManager: manager, cwd: dir, ui: { setWidget() {}, setStatus() {} } } };
  await user(f, collector, manager, 10);
  t.after(async () => { for (const c of all) { try { await c.shutdown(); } catch {} } integration.runningSubagents.clear(); rmSync(dir, { recursive: true, force: true }); });
  return f;
}
function harness(f: any) {
  const hooks = new Map<string, any>(); const tools = new Map<string, any>(); const messages: any[] = [];
  const api: any = { events: f.bus, on: (k: string, fn: any) => hooks.set(k, fn), registerTool: (v: any) => tools.set(v.name, v), registerCommand() {}, registerMessageRenderer() {}, registerShortcut() {}, getAllTools: () => [], sendMessage(message: any) {
    messages.push(message);
    // Persist actual parent result marker so reloads exercise the no-redelivery path.
    appendFileSync(f.manager.getSessionFile(), `${JSON.stringify({ type: "message", id: `delivered-${messages.length}`, message: { role: "custom", customType: "subagent_result", content: message.content, details: message.details } })}\n`);
  } };
  subagents(api);
  return { api, hooks, tools, messages };
}
async function tracked(f: any, mode: "standalone" | "lineage-only" | "fork" = "lineage-only", captured = captureChildUsage(f.bus, "spawn-a"), name = "Worker") {
  const sessionPath = join(f.dir, `${name}.jsonl`);
  if (mode !== "standalone") seedSubagentSessionFile({ mode, parentSessionFile: f.manager.getSessionFile(), childSessionFile: sessionPath, childCwd: f.dir });
  const tracking = await registerChildUsage(captured, { sessionPath, childId: `child-${name}`, startedAt: 20, project: f.dir }); assert.ok(tracking);
  assert.equal(await preloadUsageCollector(tracking.usageDescriptor, tracking.usageDescriptorFile), true, "trusted collector preload");
  return { sessionPath, tracking, captured };
}
async function child(f: any, tracking: any, sourceId?: string) {
  const d = tracking.usageDescriptor;
  if (!existsSync(d.sessionPath)) writeFileSync(d.sessionPath, `${JSON.stringify({ type: "session", version: 3, id: sourceId ?? "actual-header", timestamp: new Date().toISOString(), cwd: f.dir })}\n`);
  const manager = SessionManager.open(d.sessionPath);
  const bus = new Bus();
  const collector = await UsageCollector.start({ agentDir: join(f.dir, "DIFFERENT-child-config"), manager, descriptor: d, events: bus, appendEntry: (k: string, v: any) => manager.appendCustomEntry(k, v) });
  f.all.push(collector);
  return { manager, collector, bus };
}
function lifecycle(f: any, sessionPath: string, tracking: any, status = "completed") {
  const artifactDir = getArtifactDir(f.manager.getSessionDir(), f.manager.getSessionId());
  const record: any = { version: 1, id: tracking?.usageDescriptor.childId ?? "legacy-child", name: "Worker", task: "PRIVATE TASK", surface: "fake-pane", startTime: 20, sessionFile: sessionPath, parentSessionFile: f.manager.getSessionFile(), interactive: false, status, updatedAt: 20, result: { name: "Worker", summary: "done", exitCode: 0, elapsed: 1 }, ...tracking };
  writeChildLifecycleRecord(record, artifactDir);
  registerName(artifactDir, record.name, { sessionFile: sessionPath, sessionId: getSessionId(sessionPath), childId: record.id });
  return { artifactDir, record };
}
function env(t: any, values: Record<string, string | undefined>) {
  const before = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}
function fakeLauncher(t: any, dir: string) {
  const log = join(dir, "launcher.log"), executable = join(dir, "herdr");
  writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncase "$1 $2" in\n'--version ') echo fake ;;\n'pane run') echo '{}' ;;\n*) echo 'unexpected pane mutation' >&2; exit 1 ;;\nesac\n`); chmodSync(executable, 0o700);
  env(t, { PATH: `${dir}:${process.env.PATH}`, HERDR_ENV: "1", HERDR_PANE_ID: "root-pane", PI_SUBAGENT_ROOT_PANE: "root-pane", PI_SUBAGENT_LAYOUT_MODE: undefined, PI_SUBAGENT_SESSION: undefined, PI_SUBAGENT_SURFACE_REGISTRY: undefined });
  return log;
}

test("store failure delivers result, retains all evidence, then recovery commits once and cleans without redelivery", async t => {
  const f = await fixture(t); const h = harness(f); await h.hooks.get("session_start")({}, f.ctx);
  const { sessionPath, tracking } = await tracked(f); const c = await child(f, tracking);
  await user(f, c.collector, c.manager, 30); await assistant(c.collector, c.manager);
  const { artifactDir, record } = lifecycle(f, sessionPath, tracking);
  const lock = new DatabaseSync(tracking.usageDescriptor.ledgerPath); lock.exec("BEGIN IMMEDIATE");
  try {
    integration.deliverResultAndDeleteSession(h.api, { customType: "subagent_result", content: "done", details: { id: record.id, stats: { totalTokens: 999 } } }, artifactDir, "Worker", sessionPath, f.manager.getSessionFile(), record.id);
    assert.equal(h.messages.length, 1); assert.ok(existsSync(sessionPath)); assert.ok(existsSync(tracking.usageDescriptorFile)); assert.ok(readNameRegistry(artifactDir).Worker);
    assert.equal(readChildLifecycleRecord(childLifecyclePath(artifactDir, record.id))?.usageAccounting, "pending");
  } finally { lock.exec("ROLLBACK"); lock.close(); }
  await integration.reconcileChildLifecycles(h.api, f.ctx);
  assert.equal(h.messages.length, 1); assert.equal(existsSync(sessionPath), false); assert.equal(existsSync(tracking.usageDescriptorFile), false); assert.equal(readNameRegistry(artifactDir).Worker, undefined);
  const s = await f.collector.store.snapshot(); assert.equal(s.usage.length, 1); assert.equal(s.usage[0].sessionId, tracking.usageDescriptor.sessionId); assert.equal(s.usage[0].workflowId, tracking.usageDescriptor.workflowId);
  assert.equal(s.usage[0].tokens.total, 16); assert.equal(h.messages[0].details.usageWorkflowId, tracking.usageDescriptor.workflowId);
  await h.hooks.get("session_shutdown")();
});

test("restored completed and already-delivered paths respect shared missing-adapter gate", async t => {
  const f = await fixture(t); const h = harness(f);
  const { sessionPath, tracking } = await tracked(f);
  const unavailable = { ...tracking, usageDescriptor: { ...tracking.usageDescriptor, collectorPath: join(f.dir, "missing-collector.ts") } };
  const { artifactDir, record } = lifecycle(f, sessionPath, unavailable);
  integration.startReconciledChild(h.api, record, artifactDir, f.manager.getSessionFile());
  assert.equal(h.messages.length, 1); assert.ok(existsSync(sessionPath)); assert.ok(existsSync(tracking.usageDescriptorFile));
  const delivered = readChildLifecycleRecord(childLifecyclePath(artifactDir, record.id))!;
  integration.startReconciledChild(h.api, delivered, artifactDir, f.manager.getSessionFile());
  assert.equal(h.messages.length, 1); assert.ok(existsSync(sessionPath));
  deleteDeliveredSubagentSession(artifactDir, "Worker", sessionPath); assert.ok(existsSync(sessionPath));
  await h.hooks.get("session_shutdown")();
});

test("after reload delivered tracking record refuses unresolved resume before await/pane/launcher or mutation", async t => {
  const f = await fixture(t); const log = fakeLauncher(t, f.dir);
  const { sessionPath, tracking } = await tracked(f);
  const { artifactDir, record } = lifecycle(f, sessionPath, tracking, "delivered");
  updateChildLifecycleRecord(artifactDir, record.id, { usageAccounting: undefined }); // Missing pending flag is still unresolved.
  writeSubagentLoadout(sessionPath, { agent: null, toolAllowlist: "read", model: "physical-provider/model-one", thinking: null, systemPromptMode: null, identity: null, spawnable: null, autoExit: true, cwd: f.dir, agentDir: f.dir });
  const h = harness(f); // A fresh parent runtime, with empty running map, not a synthetic guard call.
  const before = [sessionPath, childLifecyclePath(artifactDir, record.id), join(artifactDir, "subagent-registry.json"), tracking.usageDescriptorFile].map(p => readFileSync(p, "utf8"));
  const result = await h.tools.get("subagent_message").execute("followup", { name: "Worker", message: "new task" }, undefined, undefined, f.ctx);
  assert.match(result.content[0].text, /accounting pending or unresolved/); assert.equal(result.details.id, record.id); assert.equal(integration.runningSubagents.size, 0);
  assert.deepEqual([sessionPath, childLifecyclePath(artifactDir, record.id), join(artifactDir, "subagent-registry.json"), tracking.usageDescriptorFile].map(p => readFileSync(p, "utf8")), before);
  assert.equal(existsSync(log), false, "refusal must precede even launcher availability probes");
  assert.equal(listChildLifecycleRecords(artifactDir).length, 1);
  await h.hooks.get("session_shutdown")();
});

test("fork baseline excludes copied prefix; two physical models and nested immutable workflow retain source and parent ledger", async t => {
  const f = await fixture(t);
  const captured = captureChildUsage(f.bus, "spawn-a")!;
  await user(f, f.collector, f.manager, 15); // B is consumed while A's child is being set up.
  const { tracking } = await tracked(f, "fork", captured);
  assert.ok(tracking.usageDescriptor.baseline > 0); assert.equal(tracking.usageDescriptor.workflowId, captured.context.workflowId);
  const c = await child(f, tracking); await user(f, c.collector, c.manager, 30); await assistant(c.collector, c.manager, 31, "model-one", true); await assistant(c.collector, c.manager, 32, "model-two", true);
  const nestedCapture = captureChildUsage(c.bus, "nested-spawn")!;
  assert.equal(nestedCapture.context.workflowId, captured.context.workflowId);
  const nestedPath = join(f.dir, "nested.jsonl"); seedSubagentSessionFile({ mode: "lineage-only", parentSessionFile: c.manager.getSessionFile(), childSessionFile: nestedPath, childCwd: f.dir });
  const nested = await registerChildUsage(nestedCapture, { sessionPath: nestedPath, childId: "nested-child", startedAt: 33, project: f.dir }); assert.ok(nested);
  const n = await child(f, nested); await user(f, n.collector, n.manager, 40); await assistant(n.collector, n.manager, 41, "nested-model", true);
  assert.equal(nested.usageDescriptor.ledgerPath, tracking.usageDescriptor.ledgerPath); assert.equal(nested.usageDescriptor.parentSessionId, tracking.usageDescriptor.sessionId);
  assert.equal(reconcileChildUsage(tracking.usageDescriptor), "complete"); assert.equal(reconcileChildUsage(nested.usageDescriptor), "complete");
  const s = await f.collector.store.snapshot(); assert.equal(s.usage.length, 3); assert.deepEqual(s.usage.map((x: any) => x.model).sort(), ["model-one", "model-two", "nested-model"]);
  assert.ok(s.usage.every((x: any) => x.workflowId === captured.context.workflowId && x.source === "pi-interactive-subagents" && x.rootSessionId === captured.context.rootSessionId));
  const details = childUsageDetails(tracking.usageDescriptor, f.bus); assert.equal((details.usageContext as any).workflowId, captured.context.workflowId);
  assert.equal((details.usageContext as any).sessionId, captured.context.sessionId);
  const b = captureChildUsage(f.bus)!.context.workflowId;
  const continuation = { role: "user", content: "CHILD RESULT CONTINUATION", timestamp: 42, usageContext: details.usageContext };
  await f.collector.messageStart(continuation); f.manager.appendMessage(continuation); await f.collector.collect();
  await assistant(f.collector, f.manager, 43, "parent-model", true);
  const after = await f.collector.store.snapshot();
  assert.equal(after.usage.length, 4); assert.equal(after.usage.find((x: any) => x.model === "parent-model").workflowId, b);
  assert.ok(after.usage.filter((x: any) => x.model !== "parent-model").every((x: any) => x.workflowId === captured.context.workflowId));
  assert.equal(after.workflows.length, 2, "late A result is a dependency of active B, not a new/reassigned workflow");
  assert.equal(existsSync(join(f.dir, "DIFFERENT-child-config", "usage")), false);
});

test("private descriptor fallback survives registration failure, binds standalone actual header and replay stays idempotent", async t => {
  const f = await fixture(t); const capture = captureChildUsage(f.bus)!;
  const lock = new DatabaseSync(f.collector.store.path); lock.exec("BEGIN IMMEDIATE");
  let result: any;
  try { result = await tracked(f, "standalone", capture); } finally { lock.exec("ROLLBACK"); lock.close(); }
  const { sessionPath, tracking } = result; const d = tracking.usageDescriptor;
  assert.equal(d.sessionId, `pending:${createHash("sha256").update(resolve(sessionPath)).digest("hex")}`); assert.equal(d.baseline, 0);
  assert.equal((await f.collector.store.snapshot()).sessions.some((s: any) => s.id === d.sessionId), false);
  assert.equal(statSync(tracking.usageDescriptorFile).mode & 0o777, 0o600); assert.deepEqual(readChildDescriptor(tracking.usageDescriptorFile), d); assert.deepEqual(readUsageDescriptor(tracking.usageDescriptorFile), d);
  assert.doesNotMatch(readFileSync(tracking.usageDescriptorFile, "utf8"), /PRIVATE|task|prompt/); assert.equal(readdirSync(dirname(tracking.usageDescriptorFile)).some(n => n.endsWith(".tmp")), false);
  const c = await child(f, tracking, "actual-new-header"); assert.notEqual(c.manager.getSessionId(), d.sessionId); assert.equal(c.collector.sessionId, d.sessionId);
  await user(f, c.collector, c.manager, 30); await assistant(c.collector, c.manager, 31, "model-one", true);
  assert.equal(reconcileChildUsage(d), "complete"); assert.equal(reconcileChildUsage(d), "complete");
  assert.equal((await f.collector.store.snapshot()).usage.length, 1);
  const raw = readFileSync(sessionPath, "utf8"); writeFileSync(sessionPath, raw.replace("actual-new-header", "rewritten-header"));
  assert.equal(reconcileChildUsage(d), "pending"); writeFileSync(sessionPath, raw);
});

test("partial suffix retains descriptor, registry and transcript; trusted adapter never guesses a ledger or imports a forged path", async t => {
  const f = await fixture(t); const { sessionPath, tracking } = await tracked(f); const c = await child(f, tracking);
  await user(f, c.collector, c.manager, 30); await assistant(c.collector, c.manager);
  appendFileSync(sessionPath, '{"id":"partial');
  const { artifactDir } = lifecycle(f, sessionPath, tracking, "delivered");
  deleteDeliveredSubagentSession(artifactDir, "Worker", sessionPath); assert.ok(existsSync(sessionPath)); assert.ok(existsSync(tracking.usageDescriptorFile)); assert.ok(readNameRegistry(artifactDir).Worker);
  const forged = join(f.dir, "forged.mjs"); const marker = join(f.dir, "imported"); writeFileSync(forged, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'bad');`); chmodSync(forged, 0o666);
  assert.equal(await preloadUsageCollector({ ...tracking.usageDescriptor, collectorPath: forged }), false); assert.equal(existsSync(marker), false);
  assert.equal(await preloadUsageCollector({ ...tracking.usageDescriptor, collectorPath: "relative-path" }), false);
});

test("restricted real launch keeps tools/providers, loads advertised collector and propagates only private descriptor path", async t => {
  const f = await fixture(t); const log = fakeLauncher(t, f.dir);
  const h = harness(f); await h.hooks.get("session_start")({}, f.ctx);
  const config = join(f.dir, "profile"); const agents = join(config, "agents"); mkdirSync(agents, { recursive: true });
  const target = join(f.dir, "target"); mkdirSync(join(target, ".pi", "agent"), { recursive: true });
  const provider = join(f.dir, "provider.ts"); writeFileSync(provider, "export default function () {}\n");
  writeFileSync(join(agents, "usage-worker.md"), `---\nmodel: physical-provider/model-one\ntools: read\nextensions: ${provider}\nauto_exit: true\nsession_mode: standalone\n---\nPRIVATE IDENTITY\n`);
  env(t, { PI_CODING_AGENT_DIR: config });
  const running: any = await integration.launchSubagent({ agent: "usage-worker", name: "Worker", task: "PRIVATE TASK", cwd: target }, f.ctx, { surface: "fake-pane", capturedUsage: captureChildUsage(f.bus, "spawn-a") });
  assert.ok(running.usageDescriptor); assert.equal(running.usageDescriptor.baseline, 0);
  const script = readFileSync(running.launchScriptFile, "utf8");
  assert.match(script, /--no-extensions/); assert.match(script, /--tools 'read,ask_question'/); assert.ok(script.includes(`-e '${COLLECTOR_PATH}'`)); assert.ok(script.includes(provider));
  assert.ok(script.includes(`PI_USAGE_DESCRIPTOR='${running.usageDescriptorFile}'`)); assert.ok(script.includes(`PI_CODING_AGENT_DIR='${join(target, ".pi", "agent")}'`));
  assert.ok(!script.includes("PI_USAGE_LEDGER")); assert.ok(!script.includes(running.usageDescriptor.ledgerPath));
  const record = readChildLifecycleRecord(childLifecyclePath(running.lifecycleArtifactDir, running.childId))!; assert.deepEqual(record.usageDescriptor, running.usageDescriptor);
  assert.match(readFileSync(log, "utf8"), /pane run fake-pane/); await h.hooks.get("session_shutdown")();
});

test("visual-status-off tick retries only accounting and cannot redeliver", async t => {
  const f = await fixture(t); const h = harness(f); await h.hooks.get("session_start")({}, f.ctx);
  const { sessionPath, tracking } = await tracked(f); const { artifactDir, record } = lifecycle(f, sessionPath, tracking, "delivered");
  const fake = join(f.dir, "tick-collector.mjs");
  writeFileSync(fake, `import {readFileSync} from 'node:fs'; export const COLLECTOR_PATH=${JSON.stringify(fake)}; export function readChildDescriptor(p){return JSON.parse(readFileSync(p,'utf8'))} export function reconcileBeforeDelete(){return 'complete'}\n`);
  const d = { ...tracking.usageDescriptor, collectorPath: fake };
  writeFileSync(tracking.usageDescriptorFile, JSON.stringify(d), { mode: 0o600 });
  updateChildLifecycleRecord(artifactDir, record.id, { usageDescriptor: d });
  assert.equal(await preloadUsageCollector(d, tracking.usageDescriptorFile), true);
  const oldSet = globalThis.setInterval, oldClear = globalThis.clearInterval, oldEnabled = integration.statusConfig.enabled;
  let tick: any, calls = 0, cleared = 0;
  integration.statusConfig.enabled = false;
  globalThis.setInterval = ((fn: any) => { calls++; tick = fn; return 12345; }) as any;
  globalThis.clearInterval = (() => { cleared++; }) as any;
  try {
    integration.startStatusRefresh(h.api); assert.equal(calls, 1); assert.equal(integration.pendingAccountingRecords().length, 1);
    tick(); await new Promise<void>(done => setImmediate(done));
    assert.equal(h.messages.length, 0); assert.equal(existsSync(sessionPath), false); assert.equal(existsSync(tracking.usageDescriptorFile), false);
    tick(); assert.equal(cleared, 1); assert.equal(integration.pendingAccountingRecords().length, 0);
    await h.hooks.get("session_shutdown")(); assert.equal(cleared, 1);
  } finally { globalThis.setInterval = oldSet; globalThis.clearInterval = oldClear; integration.statusConfig.enabled = oldEnabled; }
});

test("shutdown cancels in-flight accounting retry without deleting evidence; next session recovers it", async t => {
  const f = await fixture(t); const h = harness(f); await h.hooks.get("session_start")({}, f.ctx);
  const { sessionPath, tracking } = await tracked(f); const { artifactDir, record } = lifecycle(f, sessionPath, tracking, "delivered");
  appendFileSync(f.manager.getSessionFile(), `${JSON.stringify({ type: "message", id: "persisted-result", message: { role: "custom", customType: "subagent_result", details: { id: record.id } } })}\n`);
  const fake = join(f.dir, "shutdown-collector.mjs");
  writeFileSync(fake, `import {readFileSync} from 'node:fs'; export const COLLECTOR_PATH=${JSON.stringify(fake)}; export function readChildDescriptor(p){return JSON.parse(readFileSync(p,'utf8'))} export function reconcileBeforeDelete(){return 'complete'}\n`);
  const d = { ...tracking.usageDescriptor, collectorPath: fake };
  writeFileSync(tracking.usageDescriptorFile, JSON.stringify(d), { mode: 0o600 });
  updateChildLifecycleRecord(artifactDir, record.id, { usageDescriptor: d });
  await preloadUsageCollector(d, tracking.usageDescriptorFile);
  const oldSet = globalThis.setInterval, oldClear = globalThis.clearInterval, oldEnabled = integration.statusConfig.enabled;
  let tick: any, cleared = 0;
  globalThis.setInterval = ((fn: any) => { tick = fn; return 12345; }) as any;
  globalThis.clearInterval = (() => { cleared++; }) as any;
  integration.statusConfig.enabled = false;
  try {
    integration.startStatusRefresh(h.api); tick(); await h.hooks.get("session_shutdown")();
    await new Promise<void>(done => setImmediate(done));
    assert.equal(cleared, 1); assert.ok(existsSync(sessionPath)); assert.ok(existsSync(tracking.usageDescriptorFile)); assert.equal(h.messages.length, 0);
    const restored = harness(f); await restored.hooks.get("session_start")({}, f.ctx);
    assert.equal(restored.messages.length, 0); assert.equal(existsSync(sessionPath), false);
    await restored.hooks.get("session_shutdown")();
  } finally { globalThis.setInterval = oldSet; globalThis.clearInterval = oldClear; integration.statusConfig.enabled = oldEnabled; }
});

test("tracker absent legacy cleanup and resume preconditions stay unchanged; Claude coverage is unsupported not zero", async t => {
  assert.equal(captureChildUsage(new Bus()), undefined); assert.equal(await registerChildUsage(undefined, { sessionPath: "/unused", childId: "old", startedAt: 1, project: null }), undefined);
  assert.deepEqual(childUsageDetails(undefined, undefined, "claude"), { usageCoverage: "unsupported-cli" });
  const f = await fixture(t); fakeLauncher(t, f.dir); const h = harness(f);
  const sessionPath = join(f.dir, "legacy.jsonl"); seedSubagentSessionFile({ mode: "lineage-only", parentSessionFile: f.manager.getSessionFile(), childSessionFile: sessionPath, childCwd: f.dir });
  const { artifactDir, record } = lifecycle(f, sessionPath, undefined, "delivered");
  const result = await h.tools.get("subagent_message").execute("followup", { name: "Worker", message: "new task" }, undefined, undefined, f.ctx);
  assert.match(result.content[0].text, /no sandbox snapshot/); assert.doesNotMatch(result.content[0].text, /accounting pending/);
  deleteDeliveredSubagentSession(artifactDir, "Worker", sessionPath); assert.equal(existsSync(sessionPath), false);
  assert.equal(readChildLifecycleRecord(childLifecyclePath(artifactDir, record.id))?.usageDescriptor, undefined);
  await h.hooks.get("session_shutdown")();
});
