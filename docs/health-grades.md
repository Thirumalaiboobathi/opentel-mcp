# Per-tool health grades

`opentel-mcp-ui` shows an A–F grade for each tool in its **Tool health**
panel. Grades come only from data the dashboard already receives: the
spans in its in-memory ring buffer. No extra core attribute, metric or
configuration is involved.

The code is `packages/ui/web/data/healthGrades.ts`. If you change a
threshold there, change this page too.

## Formula

1. Group the buffered `tools/call` spans by tool name (`gen_ai.tool.name`).
   Spans without a tool name are ignored.
2. If a tool has **fewer than 10 calls**, it shows **Not enough data**
   and gets no grade. A handful of calls can swing a rate from 0% to 50%,
   so a letter grade there would be noise.
3. Otherwise, compute four signals and give each one its own letter from
   the table below.
4. **The tool's grade is the worst of the four letters.** The tooltip on
   each grade names the signal (or signals) that set it, with its value,
   and lists the others.

| Signal | How it's computed | A | B | C | D | F |
| --- | --- | --- | --- | --- | --- | --- |
| Silent-failure rate | calls returning `isError: true` (`error.type = tool_error`) ÷ calls | < 2% | < 5% | < 15% | < 30% | ≥ 30% |
| Error rate | thrown / protocol failures (status `ERROR`, any other `error.type`) ÷ calls | < 2% | < 5% | < 15% | < 30% | ≥ 30% |
| Thrash episodes | calls carrying `mcp.tool.thrash_detected = true` | 0 | — | 1 | 2–3 | ≥ 4 |
| p95 latency | 95th-percentile call duration, nearest-rank | < 1 s | < 2.5 s | < 5 s | < 10 s | ≥ 10 s |

Each bound is exclusive: a value exactly on a boundary gets the worse
letter (exactly 5% silent failures is a C, not a B).

Thrash has no B: any thrash loop is worth more than a nudge.

## Worked examples

- 20 calls, all fast, no failures: every signal is A → **A**.
- 10 calls, 1 silent failure (10%), fast: silent-failure rate is C →
  **C**, "set by silent failures 10% (C)".
- 10 calls, 2 silent failures and 2 thrown (20% each), 1 thrash episode:
  silent D, errors D, thrash C → **D**, set by both failure rates.
- 10 calls with a p95 of exactly 2.5 s and no failures: latency C → **C**.
- 3 calls, all failing: **Not enough data** (needs at least 10).

## What the grade is not

- **A recent-window view, not a lifetime one.** It covers whatever is in
  the dashboard's ring buffer right now, the same window as the feed and
  the observation matrix.
- **Not a judgment on tools with no failures but few calls.** Below 10
  calls there is simply no grade.
- **Thrash only counts when core's thrash detection is live.** In
  deployments where it can't accumulate state (see the detector banner),
  thrash episodes read as 0, so the thrash signal can only flatter a
  tool there, never penalize it.
