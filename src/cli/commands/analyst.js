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
      details: 'Expected input: one symbol string. Prefixes like BATS:SPY are accepted, but analyst flows prefer bare tickers such as SPY or QQQ.',
      output: 'symbol normalization packet',
      options: {
        symbol: { type: 'string', short: 's', required: true, example: 'SPY', description: 'Raw symbol to normalize' },
      },
      handler: (opts) => core.symbolNormalize({
        symbol: opts.symbol,
      }),
    }],
    ['chart-context', {
      description: 'Build a chart context packet for one symbol across timeframes',
      details: 'Expected input: one symbol plus one or more comma-separated timeframes. This packet is for technical context, not broad market-status scans.',
      output: 'chart context packet with per-timeframe summaries',
      options: {
        symbol: { type: 'string', short: 's', required: true, example: 'SPY', description: 'Symbol to analyze' },
        timeframes: { type: 'string', short: 't', required: true, example: '5,15,60', description: 'Comma-separated timeframes' },
        preset: { type: 'string', short: 'p', example: 'short_term_momentum', description: 'Study preset: none, macro_trend, short_term_momentum, levels_only' },
        screenshot: { type: 'boolean', description: 'Include screenshots' },
        pine: { type: 'boolean', description: 'Include Pine context' },
        lookback: { type: 'string', short: 'n', example: '120', description: 'Lookback bar count' },
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
      details: 'Expected input: a session date, region, and comma-separated symbol groups. Checkpoints may be canonical names like premarket/open_30m/midday/close or clock labels like 09:30,10:00,12:00,15:55.',
      output: 'market session packet with checkpoint rankings, spreads, and data quality',
      options: {
        date: { type: 'string', short: 'd', required: true, example: '2026-04-06', description: 'Session date' },
        region: { type: 'string', short: 'r', example: 'US', description: 'Session region' },
        checkpoints: { type: 'string', short: 'c', required: true, example: '09:30,10:00,12:00,15:55', description: 'Comma-separated checkpoints' },
        benchmarks: { type: 'string', required: true, example: 'SPY,QQQ,IWM', description: 'Comma-separated benchmark symbols' },
        sectors: { type: 'string', example: 'XLE,XLK,XLF', description: 'Comma-separated sector symbols' },
        hedges: { type: 'string', example: 'TLT,GLD,VIX', description: 'Comma-separated hedge symbols' },
        optional: { type: 'string', example: 'NVDA,AAPL,TSLA', description: 'Comma-separated optional symbols' },
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
      details: 'Expected input: a headline string, an ISO timestamp with timezone, a topic label, an asset basket, and an expected response template such as risk_on or risk_off.',
      output: 'headline response validation packet',
      options: {
        headline: { type: 'string', short: 'h', required: true, example: 'Iran signals de-escalation', description: 'Headline text' },
        timestamp: { type: 'string', short: 't', required: true, example: '2026-04-02T13:14:00Z', description: 'Headline timestamp with timezone' },
        topic: { type: 'string', required: true, example: 'risk-on relief', description: 'Narrative topic' },
        basket: { type: 'string', short: 'b', required: true, example: 'SPY,QQQ,TLT,GLD,VIX', description: 'Comma-separated asset basket' },
        before: { type: 'string', example: '30', description: 'Window before headline in minutes' },
        after: { type: 'string', example: '180', description: 'Window after headline in minutes' },
        template: { type: 'string', required: true, example: 'risk_on', description: 'Expected response template' },
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
      details: 'Expected input: a date window plus an assets JSON object grouped by asset class, for example {"equities":["SPY","QQQ"],"rates":["TLT"],"vol":["VIX"]}.',
      output: 'cross-asset regime packet',
      options: {
        from: { type: 'string', required: true, example: '2026-03-28', description: 'Start date' },
        to: { type: 'string', required: true, example: '2026-04-06', description: 'End date' },
        assets: { type: 'string', short: 'a', required: true, example: '{"equities":["SPY","QQQ"],"rates":["TLT"],"vol":["VIX"]}', description: 'JSON object of grouped assets' },
      },
      handler: (opts) => core.buildCrossAssetRegimePacket({
        date_from: opts.from,
        date_to: opts.to,
        assets: parseJson(opts.assets, {}),
      }),
    }],
    ['watchlist', {
      description: 'Build a vehicle watchlist packet from topic and regime',
      details: 'Expected input: a topic thesis, a regime view, and one or more vehicle classes from index, sector, single_name, hedge, options.',
      output: 'vehicle watchlist packet',
      options: {
        topic: { type: 'string', short: 't', required: true, example: 'US relief rally after geopolitical scare', description: 'Topic thesis' },
        regime: { type: 'string', short: 'r', required: true, example: 'short-term relief, medium-term fragile', description: 'Regime view' },
        classes: { type: 'string', short: 'c', required: true, example: 'index,sector,hedge,options', description: 'Comma-separated vehicle classes' },
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
      details: 'Expected input: a narrative title, a JSON array of claims, a symbol list, and a date window.',
      output: 'narrative validation packet',
      options: {
        title: { type: 'string', short: 't', required: true, example: 'Relief rally is real but leadership is too defensive', description: 'Narrative title' },
        claims: { type: 'string', short: 'c', required: true, example: '["headline improved sentiment","broad risk appetite did not fully confirm"]', description: 'JSON array of claims' },
        symbols: { type: 'string', short: 's', required: true, example: 'SPY,QQQ,TLT,GLD,VIX', description: 'Comma-separated symbols' },
        from: { type: 'string', required: true, example: '2026-04-02', description: 'Start date' },
        to: { type: 'string', required: true, example: '2026-04-06', description: 'End date' },
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
      details: 'Expected input: one or more comma-separated symbols. Use this before capture or analyst packets when chart-state mismatch or stale data is a concern.',
      output: 'data quality report packet',
      options: {
        symbols: { type: 'string', short: 's', required: true, example: 'SPY,QQQ,VIX', description: 'Comma-separated symbols' },
        timeframe: { type: 'string', short: 't', example: '5', description: 'Timeframe for chart-state checks' },
        lookback: { type: 'string', short: 'n', example: '200', description: 'Lookback bars for session/premarket checks' },
        region: { type: 'string', short: 'r', example: 'US', description: 'Region, default US' },
        stale: { type: 'string', example: '3600', description: 'Stale-data threshold in seconds' },
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
      details: 'Expected input: an optional max age in hours and optional screenshot directory override.',
      output: 'cleanup report packet',
      options: {
        hours: { type: 'string', short: 'h', example: '24', description: 'Maximum screenshot age in hours before deletion' },
        dir: { type: 'string', short: 'd', example: '/tmp/screenshots', description: 'Optional screenshot directory override' },
      },
      handler: (opts) => core.cleanupStaleScreenshots({
        max_age_hours: opts.hours ? Number(opts.hours) : undefined,
        screenshot_dir: opts.dir,
      }),
    }],
  ]),
});
