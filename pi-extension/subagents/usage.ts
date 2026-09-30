import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Structural v1 contract: no dependency on the optional tracker installation.
type Owner = { sessionId: string; rootSessionId: string; workflowId: string | null; source: string; toolCallId: string | null; rootToolCallId: string | null; parentToolCallId: string | null };
export type UsageContext = Readonly<Owner & { version: 1; generation: string; ledgerId: string }>;
export type ChildDescriptor = Readonly<Owner & {
  version: 1; schemaVersion: number; ledgerId: string; ledgerPath: string; collectorPath: string;
  sessionPath: string; parentSessionId: string; childId: string; baseline: number;
  fingerprint: string | null; project: string | null; attemptId: string; startedAt: number;
}>;
type Result<T> = { ok: true; value: T } | { ok: false; code: string; descriptor?: ChildDescriptor };
type Service = {
  version: 1; generation: string; capabilities: { context: boolean; children: boolean };
  captureContext(options?: Partial<Owner>): Result<UsageContext>;
  getChildDescriptor(input: { context: UsageContext; sessionId: string; sessionPath: string; childId: string; baseline: number; startedAt: number; source: string; project: string | null }): Promise<Result<ChildDescriptor>>;
};
type Events = { emit(channel: string, data: unknown): void };
export type CapturedUsage = { service: Service; context: UsageContext };
const ownerKeys = ["sessionId", "rootSessionId", "workflowId", "source", "toolCallId", "rootToolCallId", "parentToolCallId"];
const descriptorKeys = [...ownerKeys, "version", "schemaVersion", "ledgerId", "ledgerPath", "collectorPath", "sessionPath", "parentSessionId", "childId", "baseline", "fingerprint", "project", "attemptId", "startedAt"];
type Collector = { COLLECTOR_PATH: string; readChildDescriptor(path: string): ChildDescriptor; reconcileBeforeDelete(d: ChildDescriptor): "complete" | "pending" };
const collectors = new Map<string, Collector>();

function discover(events?: Events): Service | undefined {
  let service: Service | undefined;
  let accepting = true;
  try {
    events?.emit("pi-usage:v1:discover", { version: 1, reply(result: Result<Service>) {
      const s = result?.ok ? result.value : undefined;
      if (accepting && s?.version === 1 && typeof s.generation === "string" && s.capabilities?.context === true && s.capabilities?.children === true && typeof s.captureContext === "function" && typeof s.getChildDescriptor === "function") service = s;
    } });
  } catch { /* Optional telemetry. */ }
  accepting = false;
  return service;
}

/** Synchronous and immutable: call before pane creation or the first await. */
export function captureChildUsage(events?: Events, toolCallId?: string): CapturedUsage | undefined {
  try {
    const service = discover(events);
    const result = service?.captureContext(toolCallId ? { toolCallId, rootToolCallId: toolCallId, parentToolCallId: null } : undefined);
    if (service && result?.ok && result.value.workflowId) return { service, context: Object.freeze({ ...result.value }) };
  } catch { /* Tracker absence must leave legacy spawning unchanged. */ }
  return undefined;
}

export function usageDescriptorPath(sessionFile: string): string { return `${sessionFile}.usage.json`; }
function checkedDescriptor(value: any): ChildDescriptor {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(k => !descriptorKeys.includes(k)) || descriptorKeys.some(k => value[k] === undefined) || value.version !== 1 || !Number.isSafeInteger(value.schemaVersion) || !Number.isSafeInteger(value.baseline) || value.baseline < 0 || !Number.isSafeInteger(value.startedAt) || value.startedAt < 0 || !value.workflowId || value.attemptId !== `child:${value.sessionId}:${value.childId}`) throw new Error("Invalid usage descriptor");
  for (const k of ["ledgerPath", "sessionPath", "collectorPath"]) if (typeof value[k] !== "string" || !isAbsolute(value[k]) || value[k].includes("\0")) throw new Error("Invalid usage path");
  return Object.freeze({ ...value });
}
function writeDescriptor(path: string, d: ChildDescriptor): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify(d)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
    const dir = openSync(dirname(path), constants.O_RDONLY);
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally { rmSync(temp, { force: true }); }
}
export function readUsageDescriptor(path: string): ChildDescriptor | undefined {
  try {
    if (!isAbsolute(path)) return undefined;
    const s = lstatSync(path);
    if (!s.isFile() || s.isSymbolicLink() || s.size > 32768 || s.mode & 0o077 || process.getuid && s.uid !== process.getuid()) return undefined;
    return checkedDescriptor(JSON.parse(readFileSync(path, "utf8")));
  } catch { return undefined; }
}

/** After seeding, before launch. A failed registration's descriptor is recovery evidence, not an ack. */
export async function registerChildUsage(captured: CapturedUsage | undefined, params: { sessionPath: string; childId: string; startedAt: number; project: string | null }): Promise<{ usageDescriptor: ChildDescriptor; usageDescriptorFile: string; usageAccounting: "pending" } | undefined> {
  if (!captured) return undefined;
  const sessionPath = resolve(params.sessionPath);
  let sessionId = `pending:${createHash("sha256").update(sessionPath).digest("hex")}`;
  let baseline = 0;
  if (existsSync(sessionPath)) {
    const lines = readFileSync(sessionPath, "utf8").split("\n").filter(line => line.trim());
    const header = lines.length ? JSON.parse(lines[0]) : undefined;
    if (header?.type !== "session" || typeof header.id !== "string") throw new Error("Invalid seeded child session header");
    sessionId = header.id;
    baseline = lines.length - 1; // Raw entries, including copied fork markers; excludes the header.
  }
  const result = await captured.service.getChildDescriptor({ context: captured.context, sessionId, sessionPath, childId: params.childId, baseline, startedAt: params.startedAt, source: "pi-interactive-subagents", project: params.project });
  const value = result.ok ? result.value : result.descriptor;
  // Once tracking was captured, never silently launch without durable seed evidence.
  if (!value) throw new Error("Usage descriptor unavailable before child launch");
  const d = checkedDescriptor(value);
  if (d.sessionId !== sessionId || d.sessionPath !== sessionPath || d.childId !== params.childId || d.baseline !== baseline || d.startedAt !== params.startedAt || d.source !== "pi-interactive-subagents" || d.parentSessionId !== captured.context.sessionId || d.rootSessionId !== captured.context.rootSessionId || d.workflowId !== captured.context.workflowId || d.ledgerId !== captured.context.ledgerId) throw new Error("Usage descriptor identity mismatch");
  const path = usageDescriptorPath(sessionPath);
  writeDescriptor(path, d);
  await preloadUsageCollector(d, path);
  return { usageDescriptor: d, usageDescriptorFile: path, usageAccounting: "pending" };
}

/** Import only a captured, private descriptor's trusted absolute module; never scan installations. */
export async function preloadUsageCollector(d: ChildDescriptor, descriptorFile = usageDescriptorPath(d.sessionPath)): Promise<boolean> {
  try {
    checkedDescriptor(d);
    const persisted = readUsageDescriptor(descriptorFile);
    if (!persisted || JSON.stringify(persisted) !== JSON.stringify(d)) return false;
    const path = d.collectorPath;
    const st = lstatSync(path);
    // Discovery/private sidecar is the trust boundary; installed owner-managed sources may be 0664.
    if (!st.isFile() || st.isSymbolicLink() || realpathSync(path) !== path || st.mode & 0o002 || process.getuid && st.uid !== process.getuid() && st.uid !== 0) return false;
    const loaded = collectors.get(path) ?? await import(pathToFileURL(path).href) as Collector;
    if (loaded.COLLECTOR_PATH !== path || typeof loaded.readChildDescriptor !== "function" || typeof loaded.reconcileBeforeDelete !== "function") return false;
    const read = loaded.readChildDescriptor(descriptorFile);
    if (JSON.stringify(read) !== JSON.stringify(d)) return false;
    collectors.set(path, loaded);
    return true;
  } catch { return false; }
}

/** Shared synchronous cleanup gate. Missing/unloaded/broken adapters always retain evidence. */
export function reconcileChildUsage(d?: ChildDescriptor): "complete" | "pending" {
  if (!d) return "pending";
  try { return collectors.get(d.collectorPath)?.reconcileBeforeDelete(d) === "complete" ? "complete" : "pending"; }
  catch { return "pending"; }
}

/** Continuation metadata, not a second usage charge. Resolve fresh generation with the ORIGINAL owner. */
export function childUsageDetails(d?: ChildDescriptor, events?: Events, cli?: string): Record<string, unknown> {
  if (cli === "claude") return { usageCoverage: "unsupported-cli" };
  if (!d) return {};
  let usageContext: UsageContext | undefined;
  try {
    const result = discover(events)?.captureContext({ sessionId: d.parentSessionId, rootSessionId: d.rootSessionId, workflowId: d.workflowId, source: d.source, toolCallId: d.toolCallId, rootToolCallId: d.rootToolCallId, parentToolCallId: d.parentToolCallId });
    if (result?.ok) usageContext = result.value;
  } catch { /* The durable workflow/child metadata remains even if discovery fails. */ }
  return { usageChildId: d.childId, usageWorkflowId: d.workflowId, usageSessionId: d.sessionId, usageRootSessionId: d.rootSessionId, ...(usageContext ? { usageContext } : {}) };
}
