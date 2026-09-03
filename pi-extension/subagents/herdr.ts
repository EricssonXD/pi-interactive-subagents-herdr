/** Herdr surface layer for Pi sessions running inside Herdr. */
import { execFile, execFileSync } from "node:child_process";
import { createConnection } from "node:net";
import { promisify } from "node:util";
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

function hasHerdr(): boolean {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) return false;
  try {
    execFileSync("herdr", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function isHerdrAvailable(): boolean {
  return hasHerdr();
}

function requireHerdr(): void {
  if (!hasHerdr()) {
    throw new Error("Herdr is required for this surface. Start Pi inside Herdr (`herdr`).");
  }
}

function run(args: string[]): string {
  requireHerdr();
  try {
    return execFileSync("herdr", args, { encoding: "utf8" }).trim();
  } catch (error: any) {
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    throw new Error(`herdr ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`, {
      cause: error,
    });
  }
}

function runJson(args: string[]): any {
  const output = run(args);
  if (!output) throw new Error(`herdr ${args.join(" ")} returned no JSON`);
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`herdr ${args.join(" ")} returned invalid JSON: ${output.slice(0, 200)}`, {
      cause: error,
    });
  }
}

type SplitDirection = "right" | "down";
type LayoutPane = { pane_id: string; rect: { width: number; height: number } };
type LayoutNode =
  | { type: "pane"; pane_id: string }
  | { type: "split"; direction: SplitDirection; ratio: number; first: LayoutNode; second: LayoutNode };

const subagentSurfaces = new Set<string>();
let rebalancePromise: Promise<void> | null = null;

function rootPane(): string {
  return process.env.PI_SUBAGENT_ROOT_PANE ?? process.env.HERDR_PANE_ID!;
}

function surfaceRegistry(): string | null {
  return process.env.PI_SUBAGENT_SURFACE_REGISTRY || null;
}

function surfaceMarker(surface: string): string {
  return encodeURIComponent(surface);
}

function knownSurfaces(): Set<string> {
  const known = new Set(subagentSurfaces);
  const registry = surfaceRegistry();
  if (!registry) return known;
  try {
    for (const marker of readdirSync(registry)) known.add(decodeURIComponent(marker));
  } catch {
    // The registry is optional for standalone surface tests.
  }
  return known;
}

function registerSurface(surface: string): void {
  subagentSurfaces.add(surface);
  const registry = surfaceRegistry();
  if (!registry) return;
  mkdirSync(registry, { recursive: true });
  writeFileSync(join(registry, surfaceMarker(surface)), "", { mode: 0o600 });
}

function unregisterSurface(surface: string): void {
  subagentSurfaces.delete(surface);
  const registry = surfaceRegistry();
  if (!registry) return;
  try {
    unlinkSync(join(registry, surfaceMarker(surface)));
  } catch {
    // The pane may already have disappeared.
  }
}

function choosePlacement(parent: string): { fromSurface: string; direction: SplitDirection; ratio: number } {
  const known = knownSurfaces();
  if (known.size === 0) return { fromSurface: parent, direction: "right", ratio: 0.5 };

  try {
    const response = runJson(["pane", "layout", "--pane", rootPane()]);
    const panes = (response?.result?.layout?.panes ?? []) as LayoutPane[];
    const target = panes
      .filter((pane) => known.has(pane.pane_id))
      .reduce<LayoutPane | undefined>(
        (largest, pane) =>
          !largest || pane.rect.width * pane.rect.height > largest.rect.width * largest.rect.height
            ? pane
            : largest,
        undefined,
      );
    if (target) {
      return {
        fromSurface: target.pane_id,
        direction: target.rect.width >= target.rect.height ? "right" : "down",
        ratio: 0.5,
      };
    }
  } catch {
    // Layout is advisory; a normal split is safer than failing a spawn.
  }

  return { fromSurface: parent, direction: "right", ratio: 0.5 };
}

function requestApi(method: string, params: Record<string, unknown>): Promise<any> {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (!socketPath) return Promise.reject(new Error("HERDR_SOCKET_PATH is not set"));

  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error(`Herdr API ${method} timed out`));
    });
    socket.on("connect", () => {
      socket.write(JSON.stringify({ id: `pi-subagents-${Date.now()}`, method, params }) + "\n");
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        socket.end();
        if (response.error) reject(new Error(response.error.message ?? "Herdr API request failed"));
        else resolve(response.result);
      } catch (error) {
        socket.destroy();
        reject(error);
      }
    });
    socket.on("error", reject);
  });
}

function paneIds(node: LayoutNode): string[] {
  return node.type === "pane" ? [node.pane_id] : [...paneIds(node.first), ...paneIds(node.second)];
}

type RatioUpdate = { path: boolean[]; ratio: number };

function collectRatioUpdates(
  node: LayoutNode,
  main: string,
  subagents: Set<string>,
  path: boolean[] = [],
  updates: RatioUpdate[] = [],
): RatioUpdate[] {
  if (node.type === "pane") return updates;

  const first = paneIds(node.first);
  const second = paneIds(node.second);
  const firstHasMain = first.includes(main);
  const secondHasMain = second.includes(main);
  const firstIsSubagents = first.every((pane) => subagents.has(pane));
  const secondIsSubagents = second.every((pane) => subagents.has(pane));

  if (firstHasMain && secondIsSubagents) {
    updates.push({ path, ratio: 0.4 });
  } else if (secondHasMain && firstIsSubagents) {
    updates.push({ path, ratio: 0.6 });
  } else if (!firstHasMain && !secondHasMain && firstIsSubagents && secondIsSubagents) {
    updates.push({ path, ratio: first.length / (first.length + second.length) });
  }

  collectRatioUpdates(node.first, main, subagents, [...path, false], updates);
  collectRatioUpdates(node.second, main, subagents, [...path, true], updates);
  return updates;
}

async function rebalanceLayout(): Promise<void> {
  const registry = knownSurfaces();
  if (!process.env.HERDR_SOCKET_PATH || registry.size === 0) return;

  const exported = await requestApi("layout.export", { pane_id: rootPane() });
  const layout = exported?.layout;
  const root = layout?.root as LayoutNode | undefined;
  if (!root) return;

  const allPanes = paneIds(root);
  const main = rootPane();
  const subagents = allPanes.filter((pane) => pane !== main && registry.has(pane));
  const unrelated = allPanes.filter((pane) => pane !== main && !registry.has(pane));
  if (!allPanes.includes(main) || unrelated.length > 0) return;

  if (subagents.length === 0) return;
  for (const update of collectRatioUpdates(root, main, new Set(subagents))) {
    await requestApi("layout.set_split_ratio", {
      tab_id: layout.tab_id,
      path: update.path,
      ratio: update.ratio,
    });
  }
}

export const __layoutTest__ = { collectRatioUpdates, paneIds };

function scheduleRebalance(): void {
  if (!process.env.HERDR_SOCKET_PATH) return;
  const next = (rebalancePromise ?? Promise.resolve()).then(rebalanceLayout).catch(() => undefined);
  rebalancePromise = next;
  void next.finally(() => {
    if (rebalancePromise === next) rebalancePromise = null;
  });
}

export function createSurface(name: string): string {
  const parent = rootPane();
  const placement = choosePlacement(parent);
  return createSurfaceSplit(name, placement.direction, placement.fromSurface, placement.ratio);
}

export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
  ratio = 0.5,
): string {
  const herdrDirection: SplitDirection = direction === "left" || direction === "right" ? "right" : "down";
  const response = runJson([
    "pane",
    "split",
    fromSurface ?? process.env.HERDR_PANE_ID!,
    "--direction",
    herdrDirection,
    "--ratio",
    String(ratio),
    "--no-focus",
  ]);
  const pane = response?.result?.pane?.pane_id;
  if (typeof pane !== "string" || !pane) throw new Error(`Herdr did not return a pane id while creating ${name}`);
  registerSurface(pane);
  scheduleRebalance();
  return pane;
}

export function sendCommand(surface: string, command: string): void {
  run(["pane", "run", surface, command]);
}

export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(tmpdir(), "pi-subagent-scripts", `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`);
  mkdirSync(dirname(scriptPath), { recursive: true });
  const preamble = options?.scriptPreamble ? `${options.scriptPreamble.trimEnd()}\n` : "";
  writeFileSync(scriptPath, `#!/bin/bash\n${preamble}${command}\n`, { mode: 0o755 });
  sendCommand(surface, `bash '${scriptPath.replace(/'/g, "'\\''")}'`);
  return scriptPath;
}

export function readScreen(surface: string, lines = 50): string {
  requireHerdr();
  return execFileSync(
    "herdr",
    ["pane", "read", surface, "--source", "recent-unwrapped", "--lines", String(Math.max(1, lines))],
    { encoding: "utf8" },
  );
}

export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireHerdr();
  const { stdout } = await execFileAsync(
    "herdr",
    ["pane", "read", surface, "--source", "recent-unwrapped", "--lines", String(Math.max(1, lines))],
    { encoding: "utf8" },
  );
  return stdout;
}

export function closeSurface(surface: string): void {
  if (surface === rootPane()) throw new Error("Refusing to close the root Pi pane");
  run(["pane", "close", surface]);
  unregisterSurface(surface);
  scheduleRebalance();
}
