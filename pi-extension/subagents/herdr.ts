/** Herdr surface layer for Pi sessions running inside Herdr. */
import { execFile, execFileSync } from "node:child_process";
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
type PaneInfo = { pane_id: string; tab_id: string; workspace_id: string };
type Placement = { fromSurface: string; direction: SplitDirection; ratio: number };

const MIN_PANE_WIDTH = 40;
const MIN_PANE_HEIGHT = 12;
const BALANCER_PLUGIN_ID = "herdr-pane-balancer";
const subagentSurfaces = new Set<string>();

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

function targetGrid(count: number): { columns: number; rows: number } {
  const columns = Math.ceil(Math.sqrt(count));
  return { columns, rows: Math.ceil(count / columns) };
}

function layoutCanFit(width: number, height: number, count: number): boolean {
  const { columns, rows } = targetGrid(count);
  return width / columns >= MIN_PANE_WIDTH && height / rows >= MIN_PANE_HEIGHT;
}

function chooseSplit(panes: LayoutPane[], managed: Set<string>): Placement | null {
  const candidates = panes.filter((pane) => managed.has(pane.pane_id));
  const target = candidates.reduce<LayoutPane | undefined>((best, pane) => {
    if (!best) return pane;
    const score = Math.max(pane.rect.width / pane.rect.height, pane.rect.height / pane.rect.width);
    const bestScore = Math.max(best.rect.width / best.rect.height, best.rect.height / best.rect.width);
    return score > bestScore ? pane : best;
  }, undefined);
  if (!target) return null;
  return {
    fromSurface: target.pane_id,
    direction: target.rect.width >= target.rect.height ? "right" : "down",
    ratio: 0.5,
  };
}

function placementForTab(anchor: string, managed: Set<string>, nextCount: number): Placement | null {
  const response = runJson(["pane", "layout", "--pane", anchor]);
  const layout = response?.result?.layout;
  if (!layoutCanFit(layout?.area?.width ?? 0, layout?.area?.height ?? 0, nextCount)) return null;
  return chooseSplit((layout?.panes ?? []) as LayoutPane[], managed);
}

function requirePaneBalancer(): void {
  const response = runJson(["plugin", "list", "--json"]);
  const available = (response?.result?.plugins ?? []).some(
    (plugin: any) => plugin?.plugin_id === BALANCER_PLUGIN_ID && plugin?.enabled === true,
  );
  if (!available) {
    throw new Error(
      `Herdr subagent tiling requires ${BALANCER_PLUGIN_ID}. Install it with: ` +
      "herdr plugin install jeph/herdr-pane-balancer --yes",
    );
  }
}

export const __layoutTest__ = { targetGrid, layoutCanFit, chooseSplit };

export function createSurface(name: string): string {
  requirePaneBalancer();
  const parent = rootPane();
  const rootInfo = runJson(["pane", "get", parent])?.result?.pane as PaneInfo;
  const panes = (runJson(["pane", "list", "--workspace", rootInfo.workspace_id])?.result?.panes ?? []) as PaneInfo[];
  const known = knownSurfaces();
  const tabs = new Map<string, PaneInfo[]>();
  for (const pane of panes) {
    const group = tabs.get(pane.tab_id) ?? [];
    group.push(pane);
    tabs.set(pane.tab_id, group);
  }

  const mainPanes = tabs.get(rootInfo.tab_id) ?? [rootInfo];
  let placement = placementForTab(parent, new Set(mainPanes.map((pane) => pane.pane_id)), mainPanes.length + 1);
  if (placement) return createSurfaceSplit(name, placement.direction, placement.fromSurface, placement.ratio);

  const overflowTabs = [...tabs.entries()].filter(
    ([tabId, group]) => tabId !== rootInfo.tab_id && group.some((pane) => known.has(pane.pane_id)),
  );
  for (const [, group] of overflowTabs) {
    placement = placementForTab(
      group[0].pane_id,
      new Set(group.map((pane) => pane.pane_id)),
      group.length + 1,
    );
    if (placement) return createSurfaceSplit(name, placement.direction, placement.fromSurface, placement.ratio);
  }

  const response = runJson([
    "tab",
    "create",
    "--workspace",
    rootInfo.workspace_id,
    "--cwd",
    process.cwd(),
    "--label",
    `subagents-${overflowTabs.length + 1}`,
    "--no-focus",
  ]);
  const pane = response?.result?.root_pane?.pane_id;
  if (typeof pane !== "string" || !pane) throw new Error(`Herdr did not return a pane id while creating ${name}`);
  registerSurface(pane);
  return pane;
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
}
