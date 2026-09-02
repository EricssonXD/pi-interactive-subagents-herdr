import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as surface from "../pi-extension/subagents/surface.ts";

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
  "pane split") echo '{"result":{"pane":{"pane_id":"w1:p2"}}}' ;;
  "pane run"|"pane close") echo '{"result":{"ok":true}}' ;;
  "pane read") echo 'hello from herdr' ;;
esac
`,
  );
  chmodSync(herdr, 0o755);

  const oldEnv = { HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID, PATH: process.env.PATH };
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "w1:p1";
  process.env.PATH = `${dir}:${oldEnv.PATH ?? ""}`;

  try {
    assert.equal(surface.isHerdrAvailable(), true);
    assert.equal(surface.createSurface("worker"), "w1:p2");
    surface.sendCommand("w1:p2", "echo hello");
    assert.equal(surface.readScreen("w1:p2", 5).trim(), "hello from herdr");
    surface.closeSurface("w1:p2");
    const calls = readFileSync(log, "utf8");
    assert.match(calls, /pane split w1:p1 --direction right --no-focus/);
    assert.match(calls, /pane run w1:p2 echo hello/);
    assert.match(calls, /pane read w1:p2 --source recent-unwrapped --lines 5/);
    assert.match(calls, /pane close w1:p2/);
  } finally {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key as keyof NodeJS.ProcessEnv];
      else process.env[key as keyof NodeJS.ProcessEnv] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
