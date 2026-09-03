# Development Testing

## Timed 10-agent layout and handoff test

Use this test to verify nested spawning, dynamic tiling, answer validation, parked panes, and coordinated shutdown.

### Expected topology

- 10 Luna agents total: 1 orchestrator plus 9 scouts.
- The orchestrator spawns exactly one scout every 5 seconds.
- Use unique names `luna-math-01` through `luna-math-09`.
- Every scout must use the `scout` profile and `azure-foundry/gpt-5.6-luna`.
- Watch the Herdr tab while panes are added; each new pane should trigger equal-area retiling without moving or closing the controller pane.

### Scout jobs

| Scout | Addition | Expected answer |
| --- | ---: | ---: |
| `luna-math-01` | 17 + 25 | 42 |
| `luna-math-02` | 34 + 18 | 52 |
| `luna-math-03` | 46 + 27 | 73 |
| `luna-math-04` | 58 + 19 | 77 |
| `luna-math-05` | 63 + 29 | 92 |
| `luna-math-06` | 71 + 16 | 87 |
| `luna-math-07` | 85 + 14 | 99 |
| `luna-math-08` | 92 + 23 | 115 |
| `luna-math-09` | 108 + 37 | 145 |

### Scout protocol

1. Solve the assigned addition.
2. Call `ask_question` exactly once with:

   ```text
   ANSWER <name>: <a> + <b> = <answer>
   ```

3. If the answer is wrong, the orchestrator replies with the correction and asks the scout to retry. The scout sends another answer question.
4. If the answer is correct, the orchestrator sends **no reply**. The unanswered question parks the scout and keeps its pane open.
5. Do **not** send `WAIT`: replying to the parked question wakes the scout and may let auto-exit close its pane.
6. After all scouts are correct, the orchestrator sends exactly `DONE_NOW` to each parked scout. Each scout replies with a final completion message and exits.

### Pass criteria

- All 9 scouts are instantiated before any `DONE_NOW` is sent.
- Every scout sends a correct answer, or receives correction and retries.
- Correct scouts remain visibly parked in their own panes.
- All 9 panes remain open until the orchestrator sends `DONE_NOW`.
- Exactly 9 `DONE_NOW` messages are sent, one per scout.
- Each scout emits its own completion result after `DONE_NOW`.
- A missing completion after 60 seconds is reported as a failed lifecycle check; do not hide it with `true`, sleep, or polling loops.
- All 10 agents finish successfully.
- The controller pane survives, and no subagent panes or registry markers are left behind.
