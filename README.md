# pi-fast-jev-compaction

A Pi package port of [`tamaratran/fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction), adapted to Pi's non-destructive `context` hook.

It uses TypeSafe Jev to decide, tool call by tool call, which old calls/results still need to remain in model context. User and assistant prose is not summarized or rewritten by this extension. Pi's persisted session transcript stays intact.

## 0.7.0: Pi-native real-usage thresholds

0.7.0 removes the extension's percentage/token scheduling thresholds entirely.

Automatic Jev timing now follows Pi's own resolved compaction settings for the active model:

```text
safe input ceiling = contextWindow - compaction.reserveTokens
```

The extension reads Pi's global/project settings through Pi's public `SettingsManager`, including model-specific compaction overrides. This means the same policy scales automatically to 64k, 110k, 256k, or another context window without choosing new percentages.

Automatic behavior:

```text
real Pi usage below safe input ceiling
  -> no Jev evaluation

real Pi usage above safe input ceiling + new eligible tool output
  -> Jev gets one chance to prune

Jev actually removes model-facing result content
  -> cancel the pending Pi threshold compaction once
  -> let the next provider request consume the pruned context
  -> wait for Pi/provider usage to refresh

fresh real usage back below the ceiling
  -> continue normally

fresh real usage still above the ceiling
  -> Jev may run again only if new eligible tool output exists
  -> otherwise Pi native compaction proceeds
```

Important consequences:

- `75%`, `80%`, `84%`, and `87.5%` are no longer extension policy.
- `2000/1000/1` re-evaluation gates are gone.
- The 1% aggregate reduction floor is gone; any pass that actually removes model-facing result content is useful and may be committed.
- Threshold decisions never use the local `estimateTokens()` heuristic. Local estimates remain only for Jev request budgeting and diagnostics.
- Immediately after a successful Jev pass Pi's usage is necessarily stale, because no provider has consumed the new prompt yet. That is the single exception: the pending native threshold attempt is cancelled once, and the next successful provider response becomes authoritative.
- Manual and overflow compactions are never blocked by this threshold policy.
- If Pi auto-compaction is disabled, automatic Jev pressure evaluation is disabled too; `/jev-refresh` remains available.

With Pi's default 16,384-token reserve, the same rule naturally produces different percentages:

```text
65,536 window   -> ceiling 49,152  (~75.0%)
112,640 window  -> ceiling 96,256  (~85.5%)
262,144 window  -> ceiling 245,760 (~93.8%)
```

Those percentages are consequences of Pi's configured token reserve, not constants in this package.

## 0.6.4: keep logical fallback through transient Jev failures

0.6.4 fixes the premature native compactions observed in the first clean 0.6.3 run.

A Jev timeout/backoff/circuit-breaker event no longer invalidates already-committed logical pruning. If the extension is enabled, the API key exists, and there are committed logical decisions, Pi threshold compaction continues to be cancelled while the calibrated logical context remains below the configured native fallback boundary.

This preserves the intended distinction:

- **remote refresh health** decides whether Jev can score more tool results right now;
- **logical history validity** decides whether Pi still has to native-compact right now.

Before any logical decisions have been committed, the package keeps the old fail-open behavior: if Jev is unavailable, Pi native compaction is not delayed.

The normal 0.5 scheduling/pruning behavior restored in 0.6.3 is unchanged.

## 0.6.3: restore the 0.5 control behavior

0.6.3 deliberately rolls the active-run behavior back to the known-good 0.5.0 control after the 0.6.x grounding/read-retention experiments caused reconnaissance loops and frequent native compaction.

The current active-run policy is again:

- Jev first evaluates at **75% Pi/provider-reported context usage**.
- Later evaluations use the original 0.5 gates: about **2000** new eligible result tokens below 80%, **1000** from 80–84%, and any new eligible result at or above 84%.
- Any accepted pass that frees at least **1%** is committed.
- A `drop_result` keeps the tool-call breadcrumb and replaces the result with the explicit re-run marker.
- There is **no recurring grounding message**.
- There is **no source-read pinning**. If exact source was pruned and the model later needs it, a targeted reread is allowed to happen naturally.
- Normal Jev scheduling uses Pi/provider usage just as 0.5 did.
- The **87.5% native fallback** retains the calibrated logical-context safety check so stale Pi usage does not accidentally suppress necessary native compaction.

This release is intentionally a control restoration, not another context-scaling experiment. Once the 0.5 behavior is reconfirmed in fresh sessions, the reevaluation token gates can be scaled by context size in a separate change.

## 0.6.2: enforce source-read pins

0.6.2 fixes a protection-plumbing bug in 0.6.1.

0.6.1 correctly identified the newest successful `read` for each file/range as protected for local eligibility accounting, but the actual `compactMessages()` call still received the older projection protection set. As a result, diagnostics could report `protectedReadEvidence > 0` while Jev still scored and pruned those exact reads.

0.6.2 builds one `evaluationProjection` whose protected IDs include the source-evidence pins, and uses that same projection for:

- `collectToolCalls()` / eligibility accounting;
- the Jev `compactMessages()` evaluation;
- persisted decision mapping.

That makes the invariant real: a read reported as protected cannot become a new `drop_result` decision in that pass.

## 0.6.1: stop source-grounding thrash

0.6.1 fixes a regression introduced by the recurring grounding safeguard in 0.6.0.

- The hidden grounding message is removed entirely. Repeating it on every provider request caused local coding models to continually re-read previously pruned files instead of progressing to edits.
- The newest successful `read` result for each file/range in the current working segment is now protected from active Jev pruning. Older duplicate reads remain eligible, so repeated reads do not accumulate indefinitely.
- This protection is semantic rather than a fixed "keep N source reads" rule: one current observation is retained for each exact `path + offset + limit` range.
- Jev scheduling and native fallback continue to use the same calibrated pressure signal.
- Re-evaluation no longer uses 80/84% bands or fixed/percentage volume gates. The required new eligible-result volume is derived continuously as:
  `min(contextWindow × minReductionRatio, remaining headroom to native fallback)`.
- With the default 1% minimum reduction, a 32k/64k/128k model therefore waits for about 327/655/1311 new eligible result tokens when there is ample headroom, then automatically tightens the gate as 87.5% approaches.

The active-run rule is now:

```text
latest successful read for a file/range -> keep full result
older duplicate reads / other removable output -> Jev may prune result
new Jev pass -> after enough new removable output to matter,
                or sooner when native-fallback headroom is smaller
```

## 0.6.0: calibrated pressure and grounding safeguards

0.6.0 addresses two failure modes observed in long coding runs.

- Jev scheduling and Pi native-fallback decisions now use the **same calibrated pressure signal**: the larger of the model-facing logical-context estimate and Pi's provider-backed usage after subtracting only fresh Jev reductions that Pi has not measured yet.
- This prevents the previous disagreement where Jev saw ~80% while the native hook saw ~89% and allowed native compaction before Jev got another urgent pass.
- Re-evaluation volume gates are now **percentages of the active model's context window**, not fixed token counts:
  - 75–80% pressure: new eligible results must total about **3% of the context window**.
  - 80–84% pressure: about **1.5% of the context window**.
  - >=84% pressure: any non-empty new eligible result can trigger another pass.
- The same policy therefore scales naturally across 32k, 64k, 128k, and other context sizes.
- Whenever Jev has pruned or removed tool evidence, the model receives a short **ephemeral grounding instruction** on each provider request. It explicitly says that pruned output is unavailable even if earlier assistant reasoning describes it, and requires a fresh read/grep before exact-match edits or patches.
- The grounding instruction is produced by the `context` hook only. It is never persisted into the Pi transcript or shown as a user-authored message.
- Result-pruned markers were strengthened with the same warning so buried historical context and the latest grounding reminder agree.

The default pressure bands remain:

```text
<75%        normal work
75–80%      Jev; re-evaluate after ~3% of window in new eligible results
80–84%      Jev; re-evaluate after ~1.5% of window in new eligible results
84–87.5%    Jev whenever any new eligible result is available
>=87.5%     Pi native compaction fallback if calibrated logical pressure is still high
```

## 0.5.0: adaptive result pruning

0.5.0 tunes the turn-end strategy for long autonomous coding runs on small local context windows.

- The default Jev trigger moves from **80% to 75%**.
- The minimum accepted effective reduction drops from **25% to 1%**. Once Jev has safely identified removable result content, even a small useful reduction is committed instead of discarded.
- Active-run `drop_result` no longer preserves an arbitrary prefix of the old output. The tool call stays visible, while the result becomes an explicit marker telling the model to re-run the tool before relying on its output. In 0.6.0 the marker also warns that earlier assistant reasoning is not ground truth for exact edits.
- Re-evaluation is driven by **new eligible tool-result tokens since the last successful Jev evaluation**, not merely by another tool call appearing:
  - 75–80%: require about **2,000** new result tokens.
  - 80–84%: require about **1,000** new result tokens.
  - >=84%: any meaningful new eligible result output can trigger another pass.
- A failed Jev request does not advance the evaluation baseline, so the existing retry/backoff path can retry the same work.
- A successful but <1% pass does advance the baseline, preventing wasteful re-scoring of the same old results every turn.
- Pi native threshold requests are still delayed only while Jev is healthy, with **87.5%** as the default native fallback.

For a 65,536-token model the intended flow is approximately:

```text
0–75%       normal agent work
75–80%      first Jev pass; later passes after ~2k new result tokens
80–84%      later passes after ~1k new result tokens
84–87.5%    re-run when any meaningful new eligible result appears
>=87.5%     Pi native compaction fallback if logical context is still large
overflow    Pi overflow recovery remains the final safety net
```

## 0.4.0: turn-end result-only compaction

0.4.0 changes the Pi lifecycle to protect active coding work on small local context windows.

- Jev HTTP evaluation runs only from Pi's `turn_end` event, after an assistant response and all of that turn's tool results are complete. The pre-LLM `context` hook is apply-only and never calls Jev.
- The default Jev trigger is **80%**.
- During an active autonomous agent run, Jev may keep a call or truncate its result, but it may not remove the call itself. Upstream `drop_call` decisions are downgraded to `drop_result` so file paths, commands, and other causal breadcrumbs remain visible.
- Those deferred `drop_call` decisions are promoted only after a clean `agent_end`, when the autonomous task has finished.
- Pi's earlier native threshold requests are intercepted while Jev is healthy. The default native fallback boundary is **87.5%** of the logical context, configurable with `PI_JEV_NATIVE_FALLBACK_PERCENT`.
- If Jev is missing, failing, or its circuit breaker is open, the extension does not delay Pi native compaction.
- Native compaction sanitization no longer imports Pi-internal file-operation helpers. It uses local reconstruction and fails open to Pi native compaction on any integration error.
- Fresh Jev reductions are subtracted from Pi's stale pre-pruning usage estimate until the next provider response, preventing an immediate unnecessary native compaction.

For a 65,536-token model the intended flow is therefore approximately:

```text
0–80%       normal agent work
80–87.5%    Jev result-only pruning at completed turns
>=87.5%     Pi native compaction fallback if logical context is still large
overflow    Pi overflow recovery remains the final safety net
```

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

Pi still persists the original transcript, but native compaction respects the logical Jev history. If Pi asks for threshold compaction before the configured native fallback percentage, the extension cancels that request only while Jev is healthy. Once the logical context reaches the fallback boundary, or if Jev is unavailable, Pi native compaction proceeds.

Before native summarization proceeds, committed Jev decisions are applied to `messagesToSummarize` and `turnPrefixMessages`. File-operation metadata is rebuilt locally from the sanitized messages plus the previous native compaction metadata, so removed calls cannot leak stale paths back into the summary.

Pi may keep a raw recent tail after compaction. Jev decisions remain active until the next `context` hook reconciles them against that retained tail.

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
export PI_JEV_REQUEST_TIMEOUT_MS=8000
export PI_JEV_EVALUATION_TIMEOUT_MS=12000
export PI_JEV_DIAGNOSTICS=1
```

## Optional environment variables

| Variable | Default | Meaning |
| --- | ---: | --- |
| `PI_JEV_KEEP_THRESHOLD` | `0.5` | Jev keep-probability threshold |
| `PI_JEV_PRESERVE_RECENT_MESSAGES` | `6` | Newest messages in the **logical** transcript protected from pruning |
| `PI_JEV_MAX_STATE_TOKENS` | `25000` | Jev state budget |
| `PI_JEV_MAX_REQUEST_TOKENS` | `30000` | Jev request budget |
| `PI_JEV_MODEL` | `jev-latest` | TypeSafe Jev model |
| `PI_JEV_BASE_URL` | upstream default | Override TypeSafe System One endpoint |
| `PI_JEV_GOAL` | recent user prompts | Fixed goal override sent to Jev |
| `PI_JEV_REQUEST_TIMEOUT_MS` | `8000` | Deadline for one Jev HTTP request |
| `PI_JEV_EVALUATION_TIMEOUT_MS` | `12000` | Hard deadline for a complete Jev evaluation |
| `PI_JEV_RETRY_DELAY_MS` | `30000` | Retry backoff after an evaluation failure |
| `PI_JEV_CIRCUIT_BREAKER_FAILURES` | `2` | Consecutive failures before temporary bypass |
| `PI_JEV_CIRCUIT_BREAKER_MS` | `120000` | Circuit-breaker duration |
| `PI_JEV_DIAGNOSTICS` | `1` | Persist JSONL diagnostics |
| `PI_JEV_DIAGNOSTICS_FILE` | `~/.pi/agent/logs/fast-jev-compaction.jsonl` | Override diagnostics path |
| `PI_JEV_DIAGNOSTICS_STDERR` | `0` | Also print each diagnostic record to stderr |

## Commands

- `/jev-status` — logical-history state, Pi/gross/logical context estimates, cumulative request counters, last pass and errors.
- `/jev-stats` — alias for `/jev-status`.
- `/jev-diagnostics [N]` — show recent diagnostic events and the log path.
- `/jev-diagnostics-clear` — clear diagnostics.
- `/jev-refresh` — force a new Jev pass at the next completed turn, using the already-compacted logical history.
- `/jev-on` — enable and force a Jev pass at the next completed turn.
- `/jev-off` — disable the context filter for this process/session. This intentionally exposes Pi's unfiltered persisted transcript while disabled.

## Interpreting `/jev-status`

Example fields:

```text
context: Pi≈96.4k / 112.6k (85.6%) · Pi ceiling=96.3k · reserve=16.4k · auto-compaction=true
logical history estimate≈101k / 112.6k (89.7%) · calls=18; diagnostic/Jev budgeting only, never used for threshold decisions
persisted Pi transcript≈56.0k / 65.5k (85.4%) · calls=31; diagnostic only
committed decisions: 20 total · drop_call=0 · drop_result=18 · keep=2 · deferred drop_call=11 · restored=0
```

The persisted-transcript estimate may exceed 100%. That is expected because Pi still stores messages that the logical context has permanently filtered out.

## Diagnostic sequence

A healthy active-run evaluation typically looks like:

```text
provider_response
turn_end
  -> turn_evaluation_check
  -> evaluation_start mode=active_result_only
     -> http_start -> http_end
  -> logical_state_persisted
  -> evaluation_success
context_apply
provider_request_start
```

At a clean `agent_end`, deferred full deletions may be promoted without another Jev HTTP request. During the active run, `context_apply` must show `drop_call=0` for newly scored calls; old completed-task decisions may still contain committed `drop_call` entries.

## Upstream semantics

The vendored algorithm follows `fast-jev-compaction` 0.3.0:

- `keepResult >= threshold` -> keep call + full result.
- otherwise `keepCall >= threshold` -> upstream scores this as `drop_result`; the Pi adapter keeps the call and replaces the result with an explicit pruned marker during an active run.
- otherwise -> remove call + result.

The vendored scoring algorithm is unchanged. The Pi adapter intentionally constrains upstream `drop_call` to `drop_result` during an active agent run, replaces pruned result contents with an explicit re-run marker, and defers full call deletion until clean `agent_end`. See `THIRD_PARTY_LICENSES.md` for the MIT license notice.
