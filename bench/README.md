# Smart-route benchmark

`bun scripts/smart-route-bench.ts bench.json` replays a real demand trace (per-turn weighted tokens
from Codex session logs: uncached input + 0.1 × cached + 5 × output) against simulated account
allowances seeded from live usage, for 7 days, at 1×, 2× and 3× demand. Policies:

- **manual**: each turn stays on the account the user picked.
- **fallback**: first work account that is not near a limit, else personal.
- **smart**: `src/router/smart-route.ts` (headroom vs even-spend pace, personal weighted 0.3,
  per-conversation stickiness for 30 min).

Usage-per-token constants (`k`) are calibrated from observed snapshot deltas and are rough
(±2×); the comparison between policies, not the absolute numbers, is the result.

Result on 2026-11-23 (one day of history, 5,000 turns, looped to 7 days):

| demand | policy | turns over a limit | billed overage (M weighted tokens) | personal share |
| --- | --- | --- | --- | --- |
| 1× | manual | 2,589 | 19.7 | 22.6% |
| 1× | fallback | 0 | 0 | 0% |
| 1× | smart | 0 | 0 | 0% |
| 3× | manual | 3,159 | 113.6 | 23.2% |
| 3× | fallback | 0 | 0 | 6.2% |
| 3× | smart | 0 | 0 | 3.7% |

Manual's misses are mostly turns sent to an account already over its spend control (Whop
ChatGPT) or its 5-hour window (Fastwhop Claude at 3×). Smart spreads load across both
Whop Claude seats, keeps both under the session cap, and uses personal only as a buffer
(3.7% vs 6.2% for a fixed fallback chain at 3×).
