# Agent Thrash Detection — sweep benchmark

**ILLUSTRATIVE, NOT A PRODUCTION CLAIM.** `brokenToolRate` is an INPUT the reader supplies — every value in the first column below is a configured assumption for that row, not a measured property of any real deployment. This table shows sensitivity to that input, not a prediction of which row describes your deployment. See "Known limitations" below before citing any number here.

Fixed across every row: sessions=5000, retries=[1, 6] (uniform random), model=claude-sonnet-5, seed=42, detection threshold=3 (thrashDetection default).

| brokenToolRate | % sessions in detected loop | mean loop length | wasted cost / 1,000 sessions | mean cost / loop |
|---:|---:|---:|---:|---:|
| 0.02 | 1.12% | 3.80 | $0.25 | $0.0223 |
| 0.05 | 3.32% | 3.83 | $0.75 | $0.0226 |
| 0.1 | 6.46% | 3.85 | $1.46 | $0.0227 |
| 0.15 | 9.52% | 3.86 | $2.17 | $0.0228 |
| 0.25 | 16.62% | 3.82 | $3.73 | $0.0225 |

### Sanity check: empirical vs. closed-form expected detection rate

Expected rate = brokenToolRate x P(attempts >= threshold). Every row below passed within tolerance (4 standard errors of a binomial proportion) — see sanityCheckAgainstClosedForm() in this script; a row outside tolerance aborts the whole run instead of being shown here.

| brokenToolRate | expected % | empirical % | deviation (pp) | tolerance used (pp) |
|---:|---:|---:|---:|---:|
| 0.02 | 1.333% | 1.120% | 0.213 | 0.649 |
| 0.05 | 3.333% | 3.320% | 0.013 | 1.015 |
| 0.1 | 6.667% | 6.460% | 0.207 | 1.411 |
| 0.15 | 10.000% | 9.520% | 0.480 | 1.697 |
| 0.25 | 16.667% | 16.620% | 0.047 | 2.108 |

## Methodology

**Session isolation:** Each simulated session was assigned its own distinct, real extra.sessionId by setting the server-side InMemoryTransport's own `sessionId` property before that session's calls, driving a real @modelcontextprotocol/sdk Client against a real instrumentMcpServer()-wrapped Server over InMemoryTransport.createLinkedPair(). This mirrors how a real stateful transport (e.g. StreamableHTTPServerTransport) populates extra.sessionId internally (protocol.js's _onrequest() reads capturedTransport.sessionId). Verified post-run: the number of distinct session keys the real ThrashDetector instance observed (across both record() and clearOnSuccess()) was asserted equal to the number of sessions simulated; the run aborts with a non-zero exit code otherwise.

**Retries are simulated:** Retries are SIMULATED by a scripted policy in this file, not driven by a real LLM agent loop. Each session is independently marked "broken" with probability brokenToolRate (a configured input, not a number measured from production traffic); a broken session then makes a uniform-random integer number of attempts in [minAttempts, maxAttempts] = [1, 6], all of which fail with byte-identical error text (see IMPORTANT #4 in this file's header), then gives up.

**Token growth assumption:** Input tokens: 800 on the first attempt, +250 on each subsequent retry (linear growth, modeling context accumulation from including prior failed attempts in the prompt). Output tokens: held constant at 150 tokens on every attempt (see IMPORTANT #7 — not modeled as growing or shrinking).

**Model and price:** model=claude-sonnet-5, from DEFAULT_PRICING (src/cost/pricing.js): $3/1M input tokens, $15/1M output tokens, USD. That pricing table's own disclaimer applies here too: verify current pricing independently before citing dollar figures.

**Sweep rates used:** 0.02, 0.05, 0.1, 0.15, 0.25

**Reproduce this exact sweep:** `node bench/thrash-data-benchmark.js --sweep --sweepRates=0.02,0.05,0.1,0.15,0.25 --sessions=5000 --minAttempts=1 --maxAttempts=6 --baseTokensIn=800 --baseTokensOut=150 --tokensInGrowth=250 --model=claude-sonnet-5 --toolName=lookup_customer_record --seed=42 --out=bench/results/published-sweep-seed-42`

## Known limitations that could inflate these numbers

- Retries happen back-to-back with no delay, so every retry always lands inside the 60s detection window; real agents pacing retries further apart could see LOWER real-world detection rates.
- Every simulated failure has a perfectly stable fingerprint (identical error text every time); real failures with more message variance than fingerprint normalization collapses would fragment across multiple fingerprints, LOWERING real-world detection rates.
- brokenToolRate and the retry range are assumed configuration, not measured from production telemetry.
- Only one tool/failure mode is simulated; results do not directly transfer to a multi-tool deployment.
- The "standard OTel would show zero errors" counterfactual is true by construction (every simulated failure returns isError: true, never throws) — it demonstrates the mechanism, not an empirical discovery about real tool-call traffic.
- Mean loop length reflects each session's last EMITTED event, which can undercount raw attempts when a session gives up between reEmitAfter-aligned re-emission points (see IMPORTANT #8).
