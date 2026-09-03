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
  "plugin list") echo '{"result":{"plugins":[{"plugin_id":"herdr-pane-balancer","enabled":true}]}}' ;;
  "pane get") echo '{"result":{"pane":{"pane_id":"w1:p1","tab_id":"w1:t1","workspace_id":"w1"}}}' ;;
  "pane list")
    count=$(cat '${dir}/split-count' 2>/dev/null || echo 0)
    if [ "$count" -eq 0 ]; then
      echo '{"result":{"panes":[{"pane_id":"w1:p1","tab_id":"w1:t1","workspace_id":"w1"}]}}'
    else
      echo '{"result":{"panes":[{"pane_id":"w1:p1","tab_id":"w1:t1","workspace_id":"w1"},{"pane_id":"w1:p2","tab_id":"w1:t1","workspace_id":"w1"}]}}'
    fi
    ;;
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
  "pane layout") echo '{"result":{"layout":{"area":{"width":200,"height":100},"panes":[{"pane_id":"w1:p1","rect":{"width":100,"height":100}},{"pane_id":"w1:p2","rect":{"width":100,"height":100}}]}}}' ;;
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
    assert.equal((calls.match(/pane split w1:p1 --direction right --ratio 0\.5 --no-focus/g) ?? []).length, 2);
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

test("fails with an install command when the pane balancer is unavailable", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-herdr-plugin-test-"));
  const herdr = join(dir, "herdr");
  writeFileSync(
    herdr,
    `#!/bin/sh
case "$1 $2" in
  "--version") echo 'herdr 0.8.2' ;;
  "plugin list") echo '{"result":{"plugins":[]}}' ;;
esac
`,
  );
  chmodSync(herdr, 0o755);
  const oldEnv = {
    HERDR_ENV: process.env.HERDR_ENV,
    HERDR_PANE_ID: process.env.HERDR_PANE_ID,
    PATH: process.env.PATH,
  };
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "w3:p1";
  process.env.PATH = `${dir}:${oldEnv.PATH ?? ""}`;
  try {
    assert.throws(
      () => surface.createSurface("missing-plugin"),
      /herdr plugin install jeph\/herdr-pane-balancer --yes/,
    );
  } finally {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key as keyof NodeJS.ProcessEnv];
      else process.env[key as keyof NodeJS.ProcessEnv] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("creates an unfocused overflow tab when the next pane would be unreadable", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-herdr-overflow-test-"));
  const log = join(dir, "calls");
  const herdr = join(dir, "herdr");
  writeFileSync(
    herdr,
    `#!/bin/sh
printf '%s\n' "$*" >> '${log}'
case "$1 $2" in
  "--version") echo 'herdr 0.8.2' ;;
  "plugin list") echo '{"result":{"plugins":[{"plugin_id":"herdr-pane-balancer","enabled":true}]}}' ;;
  "pane get") echo '{"result":{"pane":{"pane_id":"w2:p1","tab_id":"w2:t1","workspace_id":"w2"}}}' ;;
  "pane list") echo '{"result":{"panes":[{"pane_id":"w2:p1","tab_id":"w2:t1","workspace_id":"w2"}]}}' ;;
  "pane layout") echo '{"result":{"layout":{"area":{"width":60,"height":20},"panes":[{"pane_id":"w2:p1","rect":{"width":60,"height":20}}]}}}' ;;
  "tab create") echo '{"result":{"root_pane":{"pane_id":"w2:p2"}}}' ;;
  "pane close") ;;
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
  process.env.HERDR_PANE_ID = "w2:p1";
  delete process.env.PI_SUBAGENT_ROOT_PANE;
  process.env.PI_SUBAGENT_SURFACE_REGISTRY = join(dir, "surfaces");
  process.env.PATH = `${dir}:${oldEnv.PATH ?? ""}`;

  try {
    assert.equal(surface.createSurface("overflow"), "w2:p2");
    surface.closeSurface("w2:p2");
    const calls = readFileSync(log, "utf8");
    assert.match(calls, /tab create --workspace w2 --cwd .* --label subagents-1 --no-focus/);
    assert.doesNotMatch(calls, /pane split/);
  } finally {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key as keyof NodeJS.ProcessEnv];
      else process.env[key as keyof NodeJS.ProcessEnv] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uses the pane-balancer grid shape and adaptive readability limits", () => {
  const expected = [
    [1, 1], [2, 1], [2, 2], [2, 2], [3, 2],
    [3, 2], [3, 3], [3, 3], [3, 3], [4, 3],
  ];
  for (let count = 1; count <= 10; count++) {
    const grid = __layoutTest__.targetGrid(count);
    assert.deepEqual([grid.columns, grid.rows], expected[count - 1]);
  }
  assert.equal(__layoutTest__.layoutCanFit(256, 68, 30), true);
  assert.equal(__layoutTest__.layoutCanFit(256, 68, 31), false);
});

test("chooses the most elongated managed pane and splits its longest axis", () => {
  assert.deepEqual(
    __layoutTest__.chooseSplit(
      [
        { pane_id: "wide", rect: { width: 120, height: 40 } },
        { pane_id: "square", rect: { width: 60, height: 60 } },
        { pane_id: "tall", rect: { width: 30, height: 120 } },
      ],
      new Set(["wide", "square", "tall"]),
    ),
    { fromSurface: "tall", direction: "down", ratio: 0.5 },
  );
});
