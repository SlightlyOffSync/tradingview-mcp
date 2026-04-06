import { register } from '../router.js';
import * as core from '../../core/analyst.js';

function parseJson(value, fallback) {
  if (!value) return fallback;
  return JSON.parse(value);
}

register('analyst', {
  description: 'Higher-level analyst wrapper packets for narrative-analysis workflows',
  subcommands: new Map([
    ['normalize-symbol', {
      description: 'Resolve a raw symbol to the canonical TradingView symbol',
      options: {
        symbol: { type: 'string', short: 's', description: 'Raw symbol to normalize' },
      },
      handler: (opts) => core.symbolNormalize({
        symbol: opts.symbol,
      }),
    }],
    ['chart-context', {
      description: 'Build a chart context packet for one symbol across timeframes',
      options: {
        symbol: { type: 'string', short: 's', description: 'Symbol to analyze' },
        timeframes: { type: 'string', short: 't', description: 'Comma-separated timeframes, e.g. 15,60,D' },
        preset: { type: 'string', short: 'p', description: 'Study preset: none, macro_trend, short_term_momentum, levels_only' },
        screenshot: { type: 'boolean', description: 'Include screenshots' },
        pine: { type: 'boolean', description: 'Include Pine context' },
        lookback: { type: 'string', short: 'n', description: 'Lookback bar count' },
      },
      handler: (opts) => core.buildChartContextPacket({
        symbol: opts.symbol,
        timeframes: String(opts.timeframes || '').split(',').filter(Boolean),
        study_preset: opts.preset,
        include_screenshot: opts.screenshot,
        include_pine_context: opts.pine,
        lookback_bars: opts.lookback ? Number(opts.lookback) : undefined,
      }),
    }],
    ['market-session', {
      description: 'Build a market session evidence packet for a given session date',
      options: {
        date: { type: 'string', short: 'd', description: 'Session date' },
        region: { type: 'string', short: 'r', description: 'Session region' },
        checkpoints: { type: 'string', short: 'c', description: 'Comma-separated checkpoints' },
        benchmarks: { type: 'string', description: 'Comma-separated benchmark symbols' },
        sectors: { type: 'string', description: 'Comma-separated sector symbols' },
        hedges: { type: 'string', description: 'Comma-separated hedge symbols' },
        optional: { type: 'string', description: 'Comma-separated optional symbols' },
      },
      handler: (opts) => core.buildMarketSessionPacket({
        session_date: opts.date,
        region: opts.region,
        checkpoints: String(opts.checkpoints || '').split(',').filter(Boolean),
        benchmarks: String(opts.benchmarks || '').split(',').filter(Boolean),
        sectors: String(opts.sectors || '').split(',').filter(Boolean),
        hedges: String(opts.hedges || '').split(',').filter(Boolean),
        optional_symbols: String(opts.optional || '').split(',').filter(Boolean),
      }),
    }],
    ['headline-response', {
      description: 'Run a headline response test against an asset basket',
      options: {
        headline: { type: 'string', short: 'h', description: 'Headline text' },
        timestamp: { type: 'string', short: 't', description: 'Headline timestamp with timezone' },
        topic: { type: 'string', description: 'Narrative topic' },
        basket: { type: 'string', short: 'b', description: 'Comma-separated asset basket' },
        before: { type: 'string', description: 'Window before headline in minutes' },
        after: { type: 'string', description: 'Window after headline in minutes' },
        template: { type: 'string', description: 'Expected response template, e.g. risk_on' },
      },
      handler: (opts) => core.runHeadlineResponseTest({
        headline: opts.headline,
        timestamp: opts.timestamp,
        topic: opts.topic,
        asset_basket: String(opts.basket || '').split(',').filter(Boolean),
        window_minutes_before: opts.before ? Number(opts.before) : undefined,
        window_minutes_after: opts.after ? Number(opts.after) : undefined,
        expected_response_template: opts.template,
      }),
    }],
    ['cross-asset', {
      description: 'Build a cross-asset regime packet',
      options: {
        from: { type: 'string', description: 'Start date' },
        to: { type: 'string', description: 'End date' },
        assets: { type: 'string', short: 'a', description: 'JSON object of grouped assets' },
      },
      handler: (opts) => core.buildCrossAssetRegimePacket({
        date_from: opts.from,
        date_to: opts.to,
        assets: parseJson(opts.assets, {}),
      }),
    }],
    ['watchlist', {
      description: 'Build a vehicle watchlist packet from topic and regime',
      options: {
        topic: { type: 'string', short: 't', description: 'Topic thesis' },
        regime: { type: 'string', short: 'r', description: 'Regime view' },
        classes: { type: 'string', short: 'c', description: 'Comma-separated vehicle classes' },
        defensive: { type: 'boolean', description: 'Include defensive candidates' },
        directional: { type: 'boolean', description: 'Include directional candidates' },
      },
      handler: (opts) => core.buildVehicleWatchlistPacket({
        topic: opts.topic,
        regime_view: opts.regime,
        vehicle_classes: String(opts.classes || '').split(',').filter(Boolean),
        include_defensive: opts.defensive,
        include_directional: opts.directional,
      }),
    }],
    ['validate-narrative', {
      description: 'Build a narrative validation packet',
      options: {
        title: { type: 'string', short: 't', description: 'Narrative title' },
        claims: { type: 'string', short: 'c', description: 'JSON array of claims' },
        symbols: { type: 'string', short: 's', description: 'Comma-separated symbols' },
        from: { type: 'string', description: 'Start date' },
        to: { type: 'string', description: 'End date' },
      },
      handler: (opts) => core.buildNarrativeValidationPacket({
        narrative_title: opts.title,
        claims: parseJson(opts.claims, []),
        symbols: String(opts.symbols || '').split(',').filter(Boolean),
        date_window: { from: opts.from, to: opts.to },
      }),
    }],
    ['data-quality', {
      description: 'Run a preflight data-quality report for one or more symbols',
      options: {
        symbols: { type: 'string', short: 's', description: 'Comma-separated symbols' },
        timeframe: { type: 'string', short: 't', description: 'Timeframe for chart-state checks' },
        lookback: { type: 'string', short: 'n', description: 'Lookback bars for session/premarket checks' },
        region: { type: 'string', short: 'r', description: 'Region, default US' },
        stale: { type: 'string', description: 'Stale-data threshold in seconds' },
      },
      handler: (opts) => core.dataQualityReport({
        symbols: String(opts.symbols || '').split(',').filter(Boolean),
        timeframe: opts.timeframe,
        lookback_bars: opts.lookback ? Number(opts.lookback) : undefined,
        region: opts.region,
        stale_after_seconds: opts.stale ? Number(opts.stale) : undefined,
      }),
    }],
    ['cleanup-screenshots', {
      description: 'Remove stale screenshot files older than the configured age threshold',
      options: {
        hours: { type: 'string', short: 'h', description: 'Maximum screenshot age in hours before deletion' },
        dir: { type: 'string', short: 'd', description: 'Optional screenshot directory override' },
      },
      handler: (opts) => core.cleanupStaleScreenshots({
        max_age_hours: opts.hours ? Number(opts.hours) : undefined,
        screenshot_dir: opts.dir,
      }),
    }],
  ]),
});
