# pi-fast-jev-compaction

A Pi package port of [`tamaratran/fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction), adapted to Pi's non-destructive `context` hook.

It uses TypeSafe Jev to decide, tool call by tool call, which old calls/results still need to remain in model context. User and assistant prose is not summarized or rewritten by this extension. Pi's persisted session transcript stays intact.

## 0.3.0: monotonic logical history

0.3.0 fixes the largest semantic difference between the previous Pi port and the upstream project.

Pi keeps the original session transcript on disk. Previous versions rebuilt every Jev evaluation from that complete transcript, which meant calls Jev had already deleted could appear in the *next Jev state* and be scored again. The model itself saw a pruned context, while Jev was reasoning over a different, fuller history.

0.3.0 maintains a separate **logical compacted history**:

```text
Pi persisted transcript:  A B C D E F G     (never rewritten)
                               |
first Jev pass:             drop B, D
                               |
logical history:           A C E F G
                               |
new H I + next Jev pass:   A C E F G H I   <- B and D never return
```

Important properties:

- Every model request is derived from the full Pi transcript **after applying all committed Jev decisions**.
- Every new Jev pass is built from that same already-compacted logical history, not from Pi's unfiltered transcript.
- Decisions are monotonic:
  - `keep -> drop_result -> drop_call` is allowed.
  - `drop_result -> keep` cannot restore the original result.
  - `drop_call` is permanent within that logical-history segment.
- A new user prompt does **not** resurrect previously dropped context and no longer causes a below-threshold Jev refresh by itself.
- Destructive logical decisions (`drop_result` / `drop_call`) are persisted as a Pi custom state entry, so `/reload`, process restart/resume, and branch restoration can reconstruct the same logical history.
- `keep` decisions are only an in-memory scoring cache. They do not need persistence because they do not change logical history.
- A failed Jev refresh keeps the last successfully committed logical history instead of falling all the way back to the unfiltered Pi transcript.
- `/jev-status` now shows Pi usage, the current logical-history estimate, and the larger persisted-transcript estimate separately.

This preserves upstream `drop_call` semantics. 0.3.0 does **not** change Jev's decisions into a safer “always keep the call” mode; if Jev says `drop_call`, the call and result disappear from logical model context just as in the upstream algorithm.

### Native Pi compaction boundary

Jev logical history is monotonic until Pi performs a real native compaction (`/compact`, overflow fallback, or an allowed native auto-compaction). After Pi writes a compaction summary, old tool IDs are no longer the active message history, so the extension records an empty logical-decision state and starts a new logical segment.

That boundary is unavoidable with Pi's current API: `session_before_compact` can cancel compaction or provide a summary, but it cannot replace persisted history with an arbitrary pruned message list the way the upstream Claude function hook can.

## Diagnostics and freeze protection

Jev HTTP requests have an 8 s timeout by default and a complete evaluation has a 12 s hard deadline. Repeated failures open a temporary circuit breaker. Diagnostics do not log prompt text, tool inputs/results, API keys, or provider payloads.

Persistent diagnostics default to:

```text
~/.pi/agent/logs/fast-jev-compaction.jsonl
```

While Jev is evaluating, the Pi TUI shows a working message and footer status instead of silently blocking the turn.

## Install

From this checkout:

```bash
pi install /absolute/path/to/pi-fast-jev-compaction
```

The package is self-contained and has no runtime npm dependencies, so `npm install` is not required.

## Required configuration

```bash
export TYPESAFE_API_KEY="..."
```

## Recommended starting configuration

```bash
export PI_JEV_COMPACT_AT_PERCENT=60
export PI_JEV_REQUEST_TIMEOUT_MS=8000
export PI_JEV_EVALUATION_TIMEOUT_MS=12000
export PI_JEV_DIAGNOSTICS=1
```

## Optional environment variables

| Variable | Default | Meaning |
| --- | ---: | --- |
| `PI_JEV_COMPACT_AT_PERCENT` | `60` | Run Jev when Pi's effective context usage reaches this percentage; committed pruning keeps applying below it |
| `PI_JEV_MIN_REDUCTION_RATIO` | `0.25` | Minimum incremental Jev reduction considered sufficient for cancelling Pi threshold compaction |
| `PI_JEV_KEEP_THRESHOLD` | `0.5` | Jev keep-probability threshold |
| `PI_JEV_PRESERVE_RECENT_MESSAGES` | `6` | Newest messages in the **logical** transcript protected from pruning |
| `PI_JEV_MAX_STATE_TOKENS` | `25000` | Jev state budget |
| `PI_JEV_MAX_REQUEST_TOKENS` | `30000` | Jev request budget |
| `PI_JEV_TRUNCATE_HEAD_CHARS` | `300` | Prefix retained when `drop_result` truncates a tool result |
| `PI_JEV_MODEL` | `jev-latest` | TypeSafe Jev model |
| `PI_JEV_BASE_URL` | upstream default | Override TypeSafe System One endpoint |
| `PI_JEV_GOAL` | recent user prompts | Fixed goal override sent to Jev |
| `PI_JEV_REQUEST_TIMEOUT_MS` | `8000` | Deadline for one Jev HTTP request |
| `PI_JEV_EVALUATION_TIMEOUT_MS` | `12000` | Hard deadline for a complete Jev evaluation |
| `PI_JEV_RETRY_DELAY_MS` | `30000` | Retry backoff after an evaluation failure |
| `PI_JEV_CIRCUIT_BREAKER_FAILURES` | `2` | Consecutive failures before temporary bypass |
| `PI_JEV_CIRCUIT_BREAKER_MS` | `120000` | Circuit-breaker duration |
| `PI_JEV_SUCCESS_FRESH_MS` | `300000` | How recent a healthy Jev pass must be before Pi threshold compaction may be cancelled |
| `PI_JEV_DIAGNOSTICS` | `1` | Persist JSONL diagnostics |
| `PI_JEV_DIAGNOSTICS_FILE` | `~/.pi/agent/logs/fast-jev-compaction.jsonl` | Override diagnostics path |
| `PI_JEV_DIAGNOSTICS_STDERR` | `0` | Also print each diagnostic record to stderr |

## Commands

- `/jev-status` — logical-history state, Pi/gross/logical context estimates, cumulative request counters, last pass and errors.
- `/jev-stats` — alias for `/jev-status`.
- `/jev-diagnostics [N]` — show recent diagnostic events and the log path.
- `/jev-diagnostics-clear` — clear diagnostics.
- `/jev-refresh` — force a new Jev pass on the next model call, **using the already-compacted logical history**.
- `/jev-on` — enable and force a Jev pass on the next model call.
- `/jev-off` — disable the context filter for this process/session. This intentionally exposes Pi's unfiltered persisted transcript while disabled.

## Interpreting `/jev-status`

Example fields:

```text
context: Pi≈39.8k / 65.5k (60.7%) · Jev trigger=60%
logical history≈24.1k / 65.5k (36.8%) · calls=11; this is what the model and next Jev pass see
persisted Pi transcript≈73.0k / 65.5k (111.4%) · calls=31; diagnostic only
committed decisions: 20 total · drop_call=15 · drop_result=3 · keep=2 · restored=0
```

The persisted-transcript estimate may exceed 100%. That is expected because Pi still stores messages that the logical context has permanently filtered out.

## Diagnostic sequence

A healthy evaluation typically looks like:

```text
context_enter
  -> evaluation_start
     -> http_start -> http_end
  -> logical_state_persisted
  -> evaluation_success
context_apply
provider_request_start
provider_response
turn_end
```

`context_enter` now records both gross and logical message/tool/token counts. On a later Jev pass, previously committed `drop_call` entries must be absent from `logicalCalls` and from the Jev state.

## Upstream semantics

The vendored algorithm follows `fast-jev-compaction` 0.2.0:

- `keepResult >= threshold` -> keep call + full result.
- otherwise `keepCall >= threshold` -> keep call + truncated result.
- otherwise -> remove call + result.

Only the Pi adapter/state-management layer differs. See `THIRD_PARTY_LICENSES.md` for the MIT license notice.
