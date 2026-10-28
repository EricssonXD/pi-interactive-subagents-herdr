---
title: "fix: Detect stalled subagent provider requests"
type: fix
status: completed
date: 2026-10-28
---

# fix: Detect stalled subagent provider requests

## Overview

Detect a Pi subagent whose model/provider request remains active without new activity, alert the parent after a configurable quiet period, and leave the child running for inspection or eventual completion.

---

## Execution Brief

**User Goal:** Catch subagent model calls that hang without an error or completion signal so the parent is not left waiting indefinitely.

**Context & Files:**
- `pi-extension/subagents/activity.ts` records `providerActive` and refreshes `updatedAt` on provider, streaming, and other activity events.
- `pi-extension/subagents/index.ts` refreshes child activity and sends parent status messages from `startStatusRefresh()`. The spawn tool returns immediately; normal child completion is delivered later by the existing watcher.
- `pi-extension/subagents/status.ts` strictly parses the shared status configuration.
- `pi-extension/subagents/subagent-done.ts` and `pi-extension/subagents/tmux.ts` already propagate explicit `stopReason: "error"`; they do not catch a provider request that never completes.
- User decision: on watchdog detection, notify the parent and leave the child pane running; do not interrupt or kill it.

---

## Problem Frame

Explicit provider failures already become `.exit` sidecar errors, but a request that never yields an error, response, or `agent_end` leaves the child watcher waiting for its normal terminal signal. The current status refresh treats an active provider as healthy indefinitely; its one-shot nudge targets settled/waiting children instead.

The watchdog should detect **provider inactivity**, not total child runtime. It must wake the parent with a clear, nonterminal timeout warning while preserving the live child and existing watcher. If the model later responds or completes, the ordinary final result must still be delivered through the current durable lifecycle path.

---

## Requirements Trace

- R1. Detect a Pi subagent with `providerActive === true` and no newer activity for a configurable quiet period.
- R2. Notify the parent once per continuous stalled episode with the child identity, configured threshold, and an explicit statement that the child remains running.
- R3. Keep the child in the running map and lifecycle record; do not close its pane, consume completion/error sidecars, or suppress its eventual real result.
- R4. Do not classify missing/invalid activity, non-provider work, or fresh streaming activity as a stalled provider request.
- R5. Keep the watchdog independent of the visual status-widget enabled flag. Scope this detection to Pi subagents with activity snapshots; do not infer Claude CLI provider state.

---

## Scope Boundaries

- Do not interrupt, terminate, retry, or restart a child when the threshold is reached.
- Do not change explicit `.exit` provider-error handling or normal `.complete` process-exit handling.
- Do not add a terminal `subagent_result` for the timeout warning. The warning is an observational status message; eventual completion remains a separate normal result.
- Do not add a provider-API timeout or claim that a slow call has definitively failed.

---

## Context & Research

### Relevant Code and Patterns

- `activity.ts`: `beforeProviderRequest()` sets `providerActive`; `afterProviderResponse()` clears it; `messageUpdate()` advances activity timestamps while streamed output arrives.
- `index.ts`: `observeRunningSubagent()` reads validated activity snapshots. `startStatusRefresh()` already runs a one-second supervision tick and emits `subagent_status` messages with `triggerTurn: true` for autonomous children.
- `index.ts`: `watchSubagent()` remains responsible for actual completion, pane cleanup, and durable result delivery. Keep that path unchanged on a watchdog warning.
- `status.ts`: strict status configuration parsing rejects unsupported settings; extend the existing typed config and validation rather than reading raw config ad hoc.
- `test/test.ts`: status parsing and one-shot status-nudge tests provide the closest test conventions.
- Repository research found no `docs/solutions/` learnings. No external research is needed; existing activity and notification patterns directly cover this behavior.

### Institutional Learnings

- Stalled status is observational, not proof that the child exited. Preserve durable lifecycle state and let existing completion/error sidecars remain authoritative.
- Result delivery is idempotent and recoverable across parent reloads. A timeout warning must not claim or clean up the terminal result.

---

## Key Technical Decisions

- Use `providerActive` plus snapshot `updatedAt` age, rather than total runtime or `activeSince` alone. `message_update` events refresh `updatedAt`, so ongoing streamed output prevents a false timeout even if one provider request is long.
- Add `status.providerStallTimeoutMs`, defaulting to 600,000 ms (10 minutes), and require a positive integer. This is a maximum quiet period while a provider request is active, not a hard cap on request duration.
- Ensure `startStatusRefresh()` starts while children are running even when `status.enabled === false`, then evaluate the watchdog before the callback's visual-status early return. The disabled-status path must work without pending accounting records.
- Emit a one-shot `subagent_status` steer for autonomous children. Keep existing quiet behavior for interactive/user-driven children. Reset the one-shot guard when provider activity ends or a newer activity snapshot shows progress, allowing a later stalled episode to be reported.
- Before alerting, let already-present `.complete` or `.exit` sidecars win the race. Missing or invalid snapshots do not establish provider inactivity.
- Do not modify `pollForExit()`, `watchSubagent()` terminal handling, lifecycle statuses, or result-delivery locks. Because spawn is fire-and-forget, an alert message—not a delayed tool return—is the mechanism that wakes the parent; the live watcher later delivers the real result if the child completes.

---

## Open Questions

### Resolved During Planning

- **What happens when the watchdog fires?** Notify the parent and leave the child running and inspectable; do not interrupt it.
- **What counts as a stall?** An active Pi provider request with no newer child activity snapshot for the configured quiet period.
- **Does timeout finish the child lifecycle?** No. The timeout warning is nonterminal; normal completion/error delivery remains authoritative.

### Deferred to Implementation

- If runtime testing shows a 10-minute quiet period is too aggressive or too lenient for supported providers, adjust the default while retaining the setting.

---

## Implementation Units

- [x] U1. **Report quiet provider requests without terminating the child**

**Goal:** Add a configurable provider-inactivity threshold and a one-shot parent alert that preserves the live child and its normal result path.

**Requirements:** R1, R2, R3, R4, R5

**Dependencies:** None

**Files:**
- Modify: `pi-extension/subagents/status.ts`
- Modify: `pi-extension/subagents/index.ts`
- Modify: `config.json.example`
- Modify: `README.md`
- Test: `test/test.ts`

**Approach:**
- Extend strict status configuration with `providerStallTimeoutMs`, default 600000 ms, and positive-integer validation. Add the default to the shared example.
- Add a one-shot provider-stall check to the existing status supervisor, based on a valid Pi activity snapshot that still has `providerActive` set and whose `updatedAt` exceeds the configured quiet period.
- Treat newer activity as progress and reset the one-shot guard; do not alert for missing/invalid snapshots, Claude CLI children, non-provider work, or a terminal sidecar already present.
- Let `startStatusRefresh()` start when there are running children even if visual status is disabled, and run the provider check before the callback returns for disabled status. For autonomous children, send a structured `subagent_status` notification that states the timeout is observational and the child is still running. Preserve the existing interactive-agent notification policy.
- Leave `runningSubagents`, lifecycle status, pane, watcher, sidecars, and final result delivery untouched. A later completion must still produce exactly the normal terminal result.
- Update the README to describe the default and clarify that this is an inactivity alert, not a kill or request deadline.

**Execution note:** Test the age boundary and lifecycle-preservation behavior without waiting in real time; use the existing injected-time/helper test pattern.

**Patterns to follow:**
- Strict config validation in `status.ts` and its tests.
- One-shot state guards and parent `subagent_status` delivery in `index.ts`.
- Activity snapshots in `activity.ts`; do not infer failure from pane readability or silence outside an active provider request.

**Test scenarios:**
- Happy path: omitted config uses 10 minutes; a positive integer override is loaded and reflected in the watchdog threshold.
- Error path: reject zero, negative, fractional, and non-number thresholds; continue rejecting unknown status keys.
- Boundary: active provider activity older than the threshold emits one parent warning; activity exactly at or below the threshold does not.
- Progress: fresh `message_update` activity while `providerActive` remains true resets the quiet period and prevents a stale warning.
- Exclusions: waiting/tool activity, `providerActive === false`, missing/invalid snapshots, and Claude CLI children do not trigger the provider warning.
- One-shot/recovery: repeated ticks during one quiet stretch emit only one warning; provider response or newer activity clears the guard so a later quiet stretch can notify again.
- Race: an existing `.complete` or `.exit` sidecar suppresses the watchdog warning so the authoritative terminal signal wins.
- Integration: with visual status disabled and no pending accounting records, a running eligible autonomous Pi child still starts supervision and wakes the parent with a provider-stall warning; it remains registered/running. Existing lifecycle and delivery tests continue to cover the independent ordinary result path.

**Verification:** The focused and full unit suite passes; a watchdog warning leaves the lifecycle running and does not interfere with normal eventual completion/result delivery.

### Luna Micro-Prompt

1. **Brainless Objective:** Add and test a configurable, nonterminal watchdog alert for Pi subagents that make no activity progress during an active provider request, without stopping the child.
2. **Exact Coordinates:** `pi-extension/subagents/status.ts:22-25, 152-162` (`StatusConfig`, `parseStatusConfig`); `pi-extension/subagents/index.ts:1151-1193` (`RunningSubagent`), `1476-1531` (`observeRunningSubagent` and adjacent supervisor helpers), `1642-1782` (provider/waiting nudge helpers and `startStatusRefresh`), `1794-1845` (`__test__` exports); `config.json.example:1-19`; `README.md:177-198`; `test/test.ts:979-1060, 3267-3470` (status config and subagent supervision tests).
3. **Spoon-Fed Logic:**
   1. Add `providerStallTimeoutMs` to the strict status config, default it to `600000`, validate it as a positive integer, and add it to `config.json.example`.
   2. In the existing supervisor, consider only valid Pi activity snapshots with `providerActive === true`; compare the current time with the latest `activity.updatedAt`, not total child runtime. Report once after the threshold, and reset the guard on provider completion or newer activity.
   3. Ensure `startStatusRefresh()` starts for running children even with `status.enabled` false and no pending accounting; execute the watchdog check before the callback's disabled-status return. Skip reporting if the snapshot is unavailable/invalid, the child is Claude CLI, it is not in provider work, or `.complete`/`.exit` already exists.
   4. Send an autonomous child a `subagent_status` steer clearly saying the request has been quiet beyond the configured threshold and the child remains running. Do not close the pane, remove the child from `runningSubagents`, mark its lifecycle completed, consume sidecars, or change the ordinary watcher/result path. Keep the existing interactive-agent no-wake policy.
   5. Add tests for config defaults/validation, threshold boundaries, fresh streaming progress, non-provider/missing/Claude exclusions, once-per-stall/recovery, terminal-sidecar race, and disabled-visual-status plus eventual normal completion.
   6. Update the README with the 10-minute default, config setting, and observational/non-terminating semantics. Run `npm test`; it must pass.
4. **Hard Lockdown Guardrail:** You are forbidden from refactoring, deleting, renaming, reorganizing, or "improving" surrounding code. Modify only the named files and ranges for this objective, run only the specified verification, report the result, and stop. If a coordinate has drifted, stop and report it instead of guessing.

---

## System-Wide Impact

- **Interaction graph:** Child activity recorder → parent status supervisor → `subagent_status` steer; the independent completion watcher continues to deliver `subagent_result` later.
- **Error propagation:** The watchdog reports suspected inactivity, not a provider error. Explicit `.exit` errors and normal `.complete` exits keep precedence.
- **State lifecycle risks:** A warning must not transition the lifecycle record from `running`, delete the session, consume terminal sidecars, or remove the pane. The per-process one-shot alert may recur after a parent reload if the same request remains stalled; final result delivery still uses existing durable deduplication.
- **API surface parity:** No public tool schema changes. The shared `config.json.example` and README document the new status setting.
- **Integration coverage:** Test parent notification while retaining a live child, then verify a later terminal signal still follows the existing result-delivery path.
- **Unchanged invariants:** Normal child completion, explicit provider errors, parent reload reconciliation, interactive-agent quiet behavior, and result delivery locks remain unchanged.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| A legitimate provider call can be quiet for a long time. | Use a conservative 10-minute inactivity threshold, make it configurable, and reset the clock when streamed/activity updates arrive. The alert does not terminate the request. |
| The status timer may not start when visual status is disabled. | Start supervision for running children regardless of widget visibility; test that path without pending accounting records. |
| A terminal signal races the watchdog tick. | Check for `.complete` and `.exit` before alerting; the existing watcher remains authoritative. |
| The parent may receive a timeout warning and later a completion result. | Make the first message explicitly nonterminal and preserve the existing separate final-result path; these represent warning and completion, not duplicate results. |
| Parent reload can repeat a warning for the same quiet request. | Use the existing in-memory one-shot pattern and disclose this bounded caveat; persistent notification bookkeeping is outside this fix. |

---

## Documentation / Operational Notes

- README describes the threshold as provider inactivity rather than maximum request duration; the watchdog remains active even when the visual status widget is disabled.
- Operators can raise `status.providerStallTimeoutMs` for providers that legitimately remain quiet longer than 10 minutes.

---

## Sources & References

- `pi-extension/subagents/activity.ts` — provider request and message activity recording.
- `pi-extension/subagents/index.ts` — supervision, status notifications, and eventual result delivery.
- `pi-extension/subagents/status.ts` — status configuration parsing.
- `pi-extension/subagents/tmux.ts` — authoritative `.complete` and `.exit` handling.
- `pi-extension/subagents/session.ts` — durable child lifecycle and result-delivery idempotency.
- `README.md` — status widget and configuration documentation.
- `test/test.ts` — existing status, sidecar, and subagent supervision tests.
