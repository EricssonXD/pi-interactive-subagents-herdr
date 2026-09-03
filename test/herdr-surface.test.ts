import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as surface from "../pi-extension/subagents/surface.ts";
import { __layoutTest__ } from "../pi-extension/subagents/herdr.ts";

test("selects Herdr and uses its pane CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-herdr-test-"));
  const log = join(dir, "calls");
  const herdr = join(dir, "herdr");
  writeFileSync(
    herdr,
    `#!/bin/sh
printf '%s\n' "$*" >> '${log}'
case "$1 $2" in
  "--version") echo 'herdr 0.1' ;;
  "pane split")
    count=$(cat '${dir}/split-count' 2>/dev/null || echo 0)
    count=$((count + 1))
    echo "$count" > '${dir}/split-count'
    if [ "$count" -eq 1 ]; then
      echo '{"result":{"pane":{"pane_id":"w1:p2"}}}'
    else
      echo '{"result":{"pane":{"pane_id":"w1:p3"}}}'
    fi
    ;;
  "pane layout") echo '{"result":{"layout":{"panes":[{"pane_id":"w1:p1","rect":{"width":100,"height":50}},{"pane_id":"w1:p2","rect":{"width":80,"height":50}}]}}}' ;;
  "pane run"|"pane close") ;;
  "pane read") echo 'hello from herdr' ;;
esac
`,
  );
  chmodSync(herdr, 0o755);

  const oldEnv = {
    HERDR_ENV: process.env.HERDR_ENV,
    HERDR_PANE_ID: process.env.HERDR_PANE_ID,
    PI_SUBAGENT_ROOT_PANE: process.env.PI_SUBAGENT_ROOT_PANE,
    PI_SUBAGENT_SURFACE_REGISTRY: process.env.PI_SUBAGENT_SURFACE_REGISTRY,
    PATH: process.env.PATH,
  };
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "w1:p1";
  process.env.PI_SUBAGENT_SURFACE_REGISTRY = join(dir, "surfaces");
  process.env.PATH = `${dir}:${oldEnv.PATH ?? ""}`;

  try {
    assert.equal(surface.isHerdrAvailable(), true);
    assert.equal(surface.createSurface("worker"), "w1:p2");
    surface.sendCommand("w1:p2", "echo hello");
    assert.equal(surface.readScreen("w1:p2", 5).trim(), "hello from herdr");
    // Simulate a nested agent process: its own pane differs, but the propagated
    // root and shared registry keep its child in the top-level layout.
    process.env.HERDR_PANE_ID = "w1:p2";
    process.env.PI_SUBAGENT_ROOT_PANE = "w1:p1";
    assert.equal(surface.createSurface("worker-2"), "w1:p3");
    assert.throws(() => surface.closeSurface("w1:p1"), /root Pi pane/);
    surface.closeSurface("w1:p2");
    surface.closeSurface("w1:p3");
    assert.deepEqual(readdirSync(join(dir, "surfaces")), []);
    const calls = readFileSync(log, "utf8");
    assert.match(calls, /pane split w1:p1 --direction right --ratio 0\.5 --no-focus/);
    assert.match(calls, /pane run w1:p2 echo hello/);
    assert.match(calls, /pane read w1:p2 --source recent-unwrapped --lines 5/);
    assert.match(calls, /pane layout --pane w1:p1/);
    assert.match(calls, /pane split w1:p2 --direction right --ratio 0\.5 --no-focus/);
    assert.match(calls, /pane close w1:p2/);
    assert.match(calls, /pane close w1:p3/);
  } finally {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key as keyof NodeJS.ProcessEnv];
      else process.env[key as keyof NodeJS.ProcessEnv] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("never uses destructive layout.apply retiling", () => {
  const source = readFileSync(join(import.meta.dirname, "../pi-extension/subagents/herdr.ts"), "utf8");
  assert.doesNotMatch(source, /requestApi\("layout\.apply"/);
});

test("rebalance ratios preserve the main pane and keep 1-10 subagents equal-area", () => {
  const buildTree = (ids: string[], depth = 0): any => {
    if (ids.length === 1) return { type: "pane", pane_id: ids[0] };
    const split = Math.ceil(ids.length / 2);
    return {
      type: "split",
      direction: depth % 2 === 0 ? "right" : "down",
      ratio: split / ids.length,
      first: buildTree(ids.slice(0, split), depth + 1),
      second: buildTree(ids.slice(split), depth + 1),
    };
  };
  const areas = (node: any, area = 1, result: number[] = []): number[] => {
    if (node.type === "pane") {
      result.push(area);
      return result;
    }
    areas(node.first, area * node.ratio, result);
    return areas(node.second, area * (1 - node.ratio), result);
  };

  for (let count = 1; count <= 10; count++) {
    const ids = Array.from({ length: count }, (_, i) => `p${i}`);
    const tree = {
      type: "split",
      direction: "right",
      ratio: 0.5,
      first: { type: "pane", pane_id: "main" },
      second: buildTree(ids),
    };
    const updates = __layoutTest__.collectRatioUpdates(tree as any, "main", new Set(ids));
    const rebalanced = JSON.parse(JSON.stringify(tree));
    for (const update of updates) {
      let node = rebalanced;
      for (const second of update.path) node = second ? node.second : node.first;
      node.ratio = update.ratio;
    }
    const [mainArea, ...subagentAreas] = areas(rebalanced);
    assert.ok(Math.abs(mainArea - 0.4) < 1e-12);
    assert.ok(subagentAreas.every((area) => Math.abs(area - 0.6 / count) < 1e-12));
  }
});
