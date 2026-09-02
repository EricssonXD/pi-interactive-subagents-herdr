import * as herdr from "./herdr.ts";
import * as tmux from "./tmux.ts";

export const isHerdrAvailable = herdr.isHerdrAvailable;

export function isMuxAvailable(): boolean {
  return herdr.isHerdrAvailable() || tmux.isMuxAvailable();
}

export function muxSetupHint(): string {
  return "Start Pi inside Herdr (`herdr`) or tmux (`tmux new -A -s pi 'pi'`).";
}

const backend = () => (herdr.isHerdrAvailable() ? herdr : tmux);

export const createSurface = (name: string) => backend().createSurface(name);
export const createSurfaceSplit = (
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
) => backend().createSurfaceSplit(name, direction, fromSurface);
export const sendCommand = (surface: string, command: string) => backend().sendCommand(surface, command);
export const sendLongCommand = (
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
) => backend().sendLongCommand(surface, command, options);
export const readScreen = (surface: string, lines?: number) => backend().readScreen(surface, lines);
export const readScreenAsync = (surface: string, lines?: number) => backend().readScreenAsync(surface, lines);
export const closeSurface = (surface: string) => backend().closeSurface(surface);

export function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: Parameters<typeof tmux.pollForExit>[2],
): ReturnType<typeof tmux.pollForExit> {
  return tmux.pollForExit(surface, signal, {
    ...options,
    readScreenAsyncFn: backend().readScreenAsync,
  });
}

export const shellEscape = tmux.shellEscape;
