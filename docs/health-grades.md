# Per-tool health grades

`opentel-mcp-ui` shows an A–F grade for each tool in its **Tool health**
panel. Grades come only from data the dashboard already receives: the
spans in its in-memory ring buffer. No extra core metric or configuration
is involved. The stale-data signal reads a span attribute core 0.17.0+
sets only for tools that report freshness (ADR 027).

The code is `packages/ui/web/data/healthGrades.ts`. If you change a
threshold there, change this page too.

## Formula

1. Group the buffered `tools/call` spans by tool name (`gen_ai.tool.name`).
   Spans without a tool name are ignored.
2. If a tool has **fewer than 10 calls**, it shows **Not enough data**
   and gets no grade. A handful of calls can swing a rate from 0% to 50%,
   so a letter grade there would be noise.
3. Otherwise, compute the signals and give each one its own letter from
   the table below. Four always apply. The fifth, **stale-data rate**,
   applies only to a tool with at least 10 responses carrying a `fresh` or
   `stale` verdict; otherwise it's **n/a** and the tool is graded on the
   other four.
4. **The tool's grade is the worst of the signal letters.** The tooltip on
   each grade names the signal (or signals) that set it, with its value,
   and lists the others.

| Signal | How it's computed | A | B | C | D | F |
| --- | --- | --- | --- | --- | --- | --- |
| Silent-failure rate | calls returning `isError: true` (`error.type = tool_error`) ÷ calls | < 2% | < 5% | < 15% | < 30% | ≥ 30% |
| Error rate | thrown / protocol failures (status `ERROR`, any other `error.type`) ÷ calls | < 2% | < 5% | < 15% | < 30% | ≥ 30% |
| Thrash episodes | calls carrying `mcp.tool.thrash_detected = true` | 0 | — | 1 | 2–3 | ≥ 4 |
| p95 latency | 95th-percentile call duration, nearest-rank | < 1 s | < 2.5 s | ≥ 2.5 s | — | — |
| Stale-data rate | responses with `mcp.tool.freshness.verdict = stale` ÷ responses with a `fresh` or `stale` verdict | < 2% | < 5% | < 15% | < 30% | ≥ 30% |

Each bound is exclusive: a value exactly on a boundary gets the worse
letter (exactly 5% silent failures is a C, not a B).

Thrash has no B: any thrash loop is worth more than a nudge.

**Stale data uses the failure-rate bounds.** A stale response isn't an
error (its span stays OK and it's never a silent failure), but the agent
acted on data older than the tool itself said was usable, so it's graded
as seriously. Responses with an `unknown` verdict (the tool sent malformed
freshness data) and responses with no freshness data at all count toward
neither side of the rate.

**Latency is capped at C.** A slow tool that works isn't broken, so latency
alone can pull a tool down to C but never to D or F. Silent-failure rate,
error rate and thrash keep the full A–F range, so a tool that's slow *and*
failing is still graded by its failures.

## Worked examples

- 20 calls, all fast, no failures: every signal is A → **A**.
- 10 calls, 1 silent failure (10%), fast: silent-failure rate is C →
  **C**, "set by silent failures 10% (C)".
- 10 calls, 2 silent failures and 2 thrown (20% each), 1 thrash episode:
  silent D, errors D, thrash C → **D**, set by both failure rates.
- 10 calls with a p95 of exactly 2.5 s and no failures: latency C → **C**.
- 10 calls with a p95 of 60 s and no failures: still **C** (latency's cap).
- 3 calls, all failing: **Not enough data** (needs at least 10).
- A quote tool, 13 responses with a verdict, 3 of them stale (23%), no
  failures: stale data D → **D**, "set by stale data 23% (D)".
- 20 calls, only 4 of them reporting freshness (all stale), no failures:
  stale data is **n/a** (4 verdicts, needs 10), so the grade comes from
  the other four signals → **A**.
- A tool that never reports freshness: stale data is n/a and never
  mentioned; graded exactly as before 0.17.0.

## What the grade is not

- **A recent-window view, not a lifetime one.** It covers whatever is in
  the dashboard's ring buffer right now, the same window as the feed and
  the observation matrix.
- **Not a judgment on tools with no failures but few calls.** Below 10
  calls there is simply no grade.
- **Not a staleness judgment on tools that don't opt in.** Only a tool
  that reports freshness in its result `_meta` can get the stale-data
  signal. With a core older than 0.17.0 it never applies.
- **Thrash only counts when core's thrash detection is live.** In
  deployments where it can't accumulate state (see the detector banner),
  thrash episodes read as 0, so the thrash signal can only flatter a
  tool there, never penalize it.
