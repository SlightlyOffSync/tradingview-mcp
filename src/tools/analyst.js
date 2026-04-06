import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/analyst.js';

export function registerAnalystTools(server) {
  server.tool('symbol_normalize', 'Resolve a raw symbol like SPY or QQQ into the canonical TradingView symbol, returning alternates and confidence.', {
    symbol: z.string(),
  }, async (args) => {
    try { return jsonResult(await core.symbolNormalize(args)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('build_chart_context_packet', 'Build a compact technical/chart packet for one symbol across one or more timeframes.', {
    symbol: z.string(),
    timeframes: z.array(z.string()),
    study_preset: z.enum(['none', 'macro_trend', 'short_term_momentum', 'levels_only']).optional(),
    include_screenshot: z.coerce.boolean().optional(),
    include_pine_context: z.coerce.boolean().optional(),
    lookback_bars: z.coerce.number().optional(),
  }, async (args) => {
    try { return jsonResult(await core.buildChartContextPacket(args)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('build_market_session_packet', 'Build a session evidence packet for a single trading day or session window, exposing checkpoints, rankings, spreads, structure stats, screenshots, and data quality.', {
    session_date: z.string(),
    region: z.string().optional(),
    checkpoints: z.array(z.string()),
    benchmarks: z.array(z.string()).optional(),
    sectors: z.array(z.string()).optional(),
    hedges: z.array(z.string()).optional(),
    optional_symbols: z.array(z.string()).optional(),
  }, async (args) => {
    try { return jsonResult(await core.buildMarketSessionPacket(args)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('run_headline_response_test', 'Test whether a market-moving headline produced the response that a candidate narrative would predict.', {
    headline: z.string(),
    timestamp: z.string(),
    topic: z.string(),
    asset_basket: z.array(z.string()),
    window_minutes_before: z.coerce.number().optional(),
    window_minutes_after: z.coerce.number().optional(),
    expected_response_template: z.string(),
  }, async (args) => {
    try { return jsonResult(await core.runHeadlineResponseTest(args)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('build_cross_asset_regime_packet', 'Summarize cross-asset behavior over a defined window so the agent can infer the dominant regime.', {
    date_from: z.string(),
    date_to: z.string(),
    assets: z.object({
      equities: z.array(z.string()).optional(),
      rates: z.array(z.string()).optional(),
      vol: z.array(z.string()).optional(),
      fx: z.array(z.string()).optional(),
      gold: z.array(z.string()).optional(),
      energy: z.array(z.string()).optional(),
      crypto: z.array(z.string()).optional(),
    }),
  }, async (args) => {
    try { return jsonResult(await core.buildCrossAssetRegimePacket(args)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('build_vehicle_watchlist_packet', 'Turn a topic or regime thesis into a structured list of candidate expressions and invalidation logic.', {
    topic: z.string(),
    regime_view: z.string(),
    vehicle_classes: z.array(z.enum(['index', 'sector', 'single_name', 'hedge', 'options'])),
    include_defensive: z.coerce.boolean().optional(),
    include_directional: z.coerce.boolean().optional(),
  }, async (args) => {
    try { return jsonResult(await core.buildVehicleWatchlistPacket(args)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('build_narrative_validation_packet', 'Given one narrative hypothesis, assemble the evidence packet that a validation subagent should inspect.', {
    narrative_title: z.string(),
    claims: z.array(z.string()),
    symbols: z.array(z.string()),
    date_window: z.object({
      from: z.string(),
      to: z.string(),
    }),
  }, async (args) => {
    try { return jsonResult(await core.buildNarrativeValidationPacket(args)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_quality_report', 'Run a preflight data-quality check for symbol resolution, chart-state mismatch risk, stale data, premarket availability, and overlay occlusion.', {
    symbols: z.array(z.string()),
    timeframe: z.string().optional(),
    lookback_bars: z.coerce.number().optional(),
    region: z.string().optional(),
    stale_after_seconds: z.coerce.number().optional(),
  }, async (args) => {
    try { return jsonResult(await core.dataQualityReport(args)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('cleanup_stale_screenshots', 'Remove screenshot files older than the configured age threshold.', {
    max_age_hours: z.coerce.number().optional(),
    screenshot_dir: z.string().optional(),
  }, async (args) => {
    try { return jsonResult(await core.cleanupStaleScreenshots(args)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
