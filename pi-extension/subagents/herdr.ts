/** Herdr surface layer for Pi sessions running inside Herdr. */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
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

function runJson(args: string[]): any {
  requireHerdr();
  return JSON.parse(execFileSync("herdr", args, { encoding: "utf8" }).trim());
}

export function createSurface(name: string): string {
  requireHerdr();
  const response = runJson([
    "pane",
    "split",
    process.env.HERDR_PANE_ID!,
    "--direction",
    "right",
    "--no-focus",
  ]);
  const pane = response?.result?.pane?.pane_id;
  if (typeof pane !== "string" || !pane) {
    throw new Error(`Herdr did not return a pane id while creating ${name}`);
  }
  return pane;
}

export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  void name;
  const response = runJson([
    "pane",
    "split",
    fromSurface ?? process.env.HERDR_PANE_ID!,
    "--direction",
    direction === "left" || direction === "right" ? "right" : "down",
    "--no-focus",
  ]);
  const pane = response?.result?.pane?.pane_id;
  if (typeof pane !== "string" || !pane) throw new Error("Herdr did not return a pane id");
  return pane;
}

export function sendCommand(surface: string, command: string): void {
  runJson(["pane", "run", surface, command]);
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
  runJson(["pane", "close", surface]);
}
