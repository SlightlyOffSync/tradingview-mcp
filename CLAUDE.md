# TradingView MCP — Claude Instructions

Analyst wrappers plus low-level TradingView chart control via CDP (port 9222).

## Operating Rule

Prefer the high-level analyst wrapper methods first. Use low-level tools only when:

1. the wrapper does not expose required detail
2. the user explicitly asks for raw chart control or raw data
3. you need Pine, replay, drawing, UI automation, or another capability that is not part of the analyst layer

Reuse wrapper packets already built in the current run. Do not rebuild the same symbol/timeframe context unless the user asks for a refresh.
High-level wrapper calls also trigger background cleanup of screenshot files older than 24 hours. Use `cleanup_stale_screenshots` directly when you need an explicit maintenance pass.

## High-Level Methods

These are the default methods for narrative-analysis workflows.

### "Build a technical chart packet for one symbol"
Use `build_chart_context_packet`.

Typical use:
1. pass `symbol`
2. pass one or more `timeframes`
3. choose `study_preset` (`none`, `macro_trend`, `short_term_momentum`, `levels_only`)
4. enable Pine context only when needed
5. enable screenshots only when visual confirmation is genuinely necessary

Use this for:

- market structure verification
- entity shallow research
- vehicle-level confirmation
- multi-timeframe chart summaries

### "Build a session-level evidence view"
Use `build_market_session_packet`.

Use this for:

- open-to-close transition
- winner/loser board
- hedge behavior check
- what the market taught today

Expected output includes:

- explicit checkpoint definitions
- requested vs resolved session date when the requested session has no bars yet
- per-symbol checkpoint matrix
- checkpoint rankings
- relative-strength spreads
- opening context
- intraday structure stats
- range stats
- screenshot file references
- data-quality metadata

### "Test whether a headline actually moved the market the right way"
Use `run_headline_response_test`.

Require:

- absolute timestamp
- at least 3 assets in the basket
- expected response template such as `risk_on`

Use this for:

- headline response test
- tension map
- narrative validation

### "Summarize cross-asset regime"
Use `build_cross_asset_regime_packet`.

Use this for:

- topic state snapshot
- mechanism families
- regime conclusion

### "Turn a thesis into candidate vehicles"
Use `build_vehicle_watchlist_packet`.

Use this for:

- vehicle watchlist
- action layer
- best expressions
- hedges and relative value candidates

### "Validate one narrative hypothesis"
Use `build_narrative_validation_packet`.

Use this for:

- per-narrative validation subagents
- support vs contradiction checks
- missing-but-needed evidence

## Low-Level Methods

Use these when the analyst wrappers are insufficient or when the task is inherently low-level.

### "What's on my chart right now?"
1. `chart_get_state` → symbol, timeframe, chart type, list of all indicators with entity IDs
2. `data_get_study_values` → current numeric values from all visible indicators (RSI, MACD, BBands, EMAs, etc.)
3. `quote_get` → real-time price, OHLC, volume for current symbol

### "What levels/lines/labels are showing?"
Custom Pine indicators draw with `line.new()`, `label.new()`, `table.new()`, `box.new()`. These are invisible to normal data tools. Use:

1. `data_get_pine_lines` → horizontal price levels drawn by indicators (deduplicated, sorted high→low)
2. `data_get_pine_labels` → text annotations with prices
3. `data_get_pine_tables` → table data formatted as rows
4. `data_get_pine_boxes` → price zones / ranges as `{high, low}` pairs

Use `study_filter` when you know the indicator name.

### "Give me price data"
- `data_get_ohlcv` with `summary: true` → compact stats
- `data_get_ohlcv` without summary → all bars
- `quote_get` → single latest price snapshot

### "Analyze my chart manually"
1. `quote_get`
2. `data_get_study_values`
3. `data_get_pine_lines`
4. `data_get_pine_labels`
5. `data_get_pine_tables`
6. `data_get_ohlcv` with `summary: true`
7. `capture_screenshot`

### "Change the chart"
- `chart_set_symbol`
- `chart_set_timeframe`
- `chart_set_type`
- `chart_manage_indicator`
- `chart_scroll_to_date`
- `chart_set_visible_range`

### "Work on Pine Script"
1. `pine_set_source`
2. `pine_smart_compile`
3. `pine_get_errors`
4. `pine_get_console`
5. `pine_get_source`
6. `pine_save`
7. `pine_new`
8. `pine_open`

### "Practice trading with replay"
1. `replay_start`
2. `replay_step`
3. `replay_autoplay`
4. `replay_trade`
5. `replay_status`
6. `replay_stop`

### "Screen multiple symbols"
- `batch_run`

### "Draw on the chart"
- `draw_shape`
- `draw_list`
- `draw_remove_one`
- `draw_clear`

### "Manage alerts"
- `alert_create`
- `alert_list`
- `alert_delete`

### "Navigate the UI"
- `ui_open_panel`
- `ui_click`
- `layout_switch`
- `ui_fullscreen`
- `capture_screenshot`

### "TradingView isn't running"
- `tv_launch`
- `tv_health_check`

## Context Management Rules

These tools can return large payloads. Follow these rules to avoid context bloat:

1. Prefer wrapper packets over low-level tool choreography for narrative-analysis tasks
2. Always reuse packet outputs already created in the current run when they still satisfy the task
3. Always use `summary: true` on `data_get_ohlcv` unless you specifically need individual bars
4. Always use `study_filter` on pine tools when you know which indicator you want
5. Never use `verbose: true` on pine tools unless the user specifically asks for raw drawing data
6. Avoid calling `pine_get_source` on complex scripts unless editing requires it
7. Avoid calling `data_get_indicator` on protected/encrypted indicators; use `data_get_study_values` instead
8. Use `capture_screenshot` only when visual confirmation is genuinely needed
9. Call `chart_get_state` once at the start when working low-level and reuse entity IDs
10. Cap OHLCV requests: `count: 20` for quick analysis, `count: 100` for deeper work, `count: 500` only when specifically needed

### Output Size Estimates (compact mode)
| Tool | Typical Output |
|------|---------------|
| `quote_get` | ~200 bytes |
| `data_get_study_values` | ~500 bytes (all indicators) |
| `data_get_pine_lines` | ~1-3 KB per study (deduplicated levels) |
| `data_get_pine_labels` | ~2-5 KB per study (capped at 50) |
| `data_get_pine_tables` | ~1-4 KB per study (formatted rows) |
| `data_get_pine_boxes` | ~1-2 KB per study (deduplicated zones) |
| `data_get_ohlcv` (summary) | ~500 bytes |
| `data_get_ohlcv` (100 bars) | ~8 KB |
| `capture_screenshot` | ~300 bytes (returns file path, not image data) |

## Tool Conventions

- All tools return `{ success: true/false, ... }`
- Entity IDs (from `chart_get_state`) are session-specific — don't cache across sessions
- Pine indicators must be **visible** on chart for pine graphics tools to read their data
- `chart_manage_indicator` requires **full indicator names**: "Relative Strength Index" not "RSI", "Moving Average Exponential" not "EMA", "Bollinger Bands" not "BB"
- Screenshots save to `screenshots/` directory with timestamps
- OHLCV capped at 500 bars, trades at 20 per request
- Pine labels capped at 50 per study by default (pass `max_labels` to override)

## Architecture

```
Claude Code ←→ MCP Server (stdio) ←→ CDP (localhost:9222) ←→ TradingView Desktop (Electron)
```

Pine graphics path: `study._graphics._primitivesCollection.dwglines.get('lines').get(false)._primitivesDataById`
