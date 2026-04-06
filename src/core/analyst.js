import { z } from 'zod';
import { promises as fs } from 'fs';
import { join } from 'path';
import { evaluate as connectionEvaluate } from '../connection.js';
import * as chart from './chart.js';
import * as data from './data.js';
import * as capture from './capture.js';
import { normalizeSymbol, symbolsMatch } from './symbol-resolver.js';

const HIGH_LEVEL_TOTAL_BUDGET_MS = 120000;
const SESSION_SYMBOL_BUDGET_MS = 12000;
const CHART_CONTEXT_BUDGET_MS = 45000;

const STUDY_PRESETS = {
  none: [],
  macro_trend: [
    { name: 'Volume' },
    { name: 'Relative Strength Index' },
    { name: 'MACD' },
    { name: 'Moving Average Exponential', inputs: { length: 20 } },
    { name: 'Moving Average Exponential', inputs: { length: 50 } },
    { name: 'Moving Average Exponential', inputs: { length: 200 } },
  ],
  short_term_momentum: [
    { name: 'Volume' },
    { name: 'Relative Strength Index' },
    { name: 'Moving Average Exponential', inputs: { length: 9 } },
    { name: 'Moving Average Exponential', inputs: { length: 20 } },
  ],
  levels_only: [],
};

const wrapperEnvelopeSchema = z.object({
  success: z.boolean(),
  packet_type: z.string(),
  data: z.record(z.string(), z.any()),
  errors: z.array(z.record(z.string(), z.any())),
  warnings: z.array(z.record(z.string(), z.any())),
  partial_results: z.boolean(),
  data_freshness: z.object({
    captured_at: z.string(),
    stale_after_seconds: z.number(),
  }),
  provenance: z.object({
    sources: z.array(z.string()),
    underlying_tools: z.array(z.string()),
    cache_hits: z.array(z.string()),
    symbols: z.array(z.string()).optional(),
    timeframes: z.array(z.string()).optional(),
  }),
});

const chartContextInputSchema = z.object({
  symbol: z.string().min(1),
  timeframes: z.array(z.string()).min(1),
  study_preset: z.enum(['none', 'macro_trend', 'short_term_momentum', 'levels_only']).default('macro_trend'),
  include_screenshot: z.boolean().default(true),
  include_pine_context: z.boolean().default(true),
  lookback_bars: z.number().int().positive().max(500).default(100),
});

const marketSessionInputSchema = z.object({
  session_date: z.string().min(1),
  region: z.string().min(1).default('US'),
  checkpoints: z.array(z.string()).min(1),
  benchmarks: z.array(z.string()).default([]),
  sectors: z.array(z.string()).default([]),
  hedges: z.array(z.string()).default([]),
  optional_symbols: z.array(z.string()).default([]),
});

const headlineResponseInputSchema = z.object({
  headline: z.string().min(1),
  timestamp: z.string().datetime({ offset: true }),
  topic: z.string().min(1),
  asset_basket: z.array(z.string()).min(3),
  window_minutes_before: z.number().int().positive().default(30),
  window_minutes_after: z.number().int().positive().default(180),
  expected_response_template: z.string().min(1),
});

const crossAssetInputSchema = z.object({
  date_from: z.string().min(1),
  date_to: z.string().min(1),
  assets: z.object({
    equities: z.array(z.string()).default([]),
    rates: z.array(z.string()).default([]),
    vol: z.array(z.string()).default([]),
    fx: z.array(z.string()).default([]),
    gold: z.array(z.string()).default([]),
    energy: z.array(z.string()).default([]),
    crypto: z.array(z.string()).default([]),
  }),
});

const vehicleWatchlistInputSchema = z.object({
  topic: z.string().min(1),
  regime_view: z.string().min(1),
  vehicle_classes: z.array(z.enum(['index', 'sector', 'single_name', 'hedge', 'options'])).min(1),
  include_defensive: z.boolean().default(true),
  include_directional: z.boolean().default(true),
});

const narrativeValidationInputSchema = z.object({
  narrative_title: z.string().min(1),
  claims: z.array(z.string()).min(1),
  symbols: z.array(z.string()).min(1),
  date_window: z.object({
    from: z.string().min(1),
    to: z.string().min(1),
  }),
});

const cleanupScreenshotsInputSchema = z.object({
  max_age_hours: z.number().positive().default(24),
  screenshot_dir: z.string().min(1).optional(),
});

const symbolNormalizeInputSchema = z.object({
  symbol: z.string().min(1),
});

const dataQualityReportInputSchema = z.object({
  symbols: z.array(z.string()).min(1),
  timeframe: z.string().default('5'),
  lookback_bars: z.number().int().positive().max(500).default(200),
  region: z.string().default('US'),
  stale_after_seconds: z.number().int().positive().default(3600),
});

const sessionCaches = new WeakMap();

function getRunCache(deps) {
  if (deps?._cache) return deps._cache;
  if (!deps || typeof deps !== 'object') {
    return new Map();
  }
  if (!sessionCaches.has(deps)) {
    sessionCaches.set(deps, new Map());
  }
  return sessionCaches.get(deps);
}

function resolveDeps(_deps = {}) {
  return {
    chart,
    data,
    capture,
    fileSystem: _deps.fileSystem || fs,
    screenshotDir: _deps.screenshotDir || _deps.capture?.SCREENSHOT_DIR || capture.SCREENSHOT_DIR,
    evaluate: _deps.evaluate || connectionEvaluate,
    now: _deps.now || (() => new Date()),
    marketData: _deps.marketData || {},
    _cache: getRunCache(_deps),
    ..._deps,
  };
}

function envelope({ packetType, data, errors = [], warnings = [], partialResults = false, now, provenance = {} }) {
  const success = errors.length === 0 || (partialResults && data && Object.keys(data).length > 0);
  const packet = {
    success,
    packet_type: packetType,
    data,
    errors,
    warnings,
    partial_results: partialResults,
    data_freshness: {
      captured_at: now.toISOString(),
      stale_after_seconds: 300,
    },
    provenance: {
      sources: provenance.sources || ['tradingview-mcp'],
      underlying_tools: provenance.underlying_tools || [],
      cache_hits: provenance.cache_hits || [],
      ...(provenance.symbols ? { symbols: provenance.symbols } : {}),
      ...(provenance.timeframes ? { timeframes: provenance.timeframes } : {}),
    },
  };
  wrapperEnvelopeSchema.parse(packet);
  return packet;
}

function makeDeadline(nowMs, budgetMs) {
  return { started_at_ms: nowMs, budget_ms: budgetMs, expires_at_ms: nowMs + budgetMs };
}

function getFileAgeAnchorMs(stats) {
  const candidates = [stats.birthtimeMs, stats.ctimeMs, stats.mtimeMs]
    .filter(value => typeof value === 'number' && Number.isFinite(value) && value > 0);
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

const cleanupPromises = new WeakMap();

function scheduleStaleScreenshotCleanup(deps) {
  if (!deps || typeof deps !== 'object') {
    return cleanupStaleScreenshots({}, { _deps: deps }).catch(() => null);
  }
  if (cleanupPromises.has(deps)) return cleanupPromises.get(deps);
  const promise = cleanupStaleScreenshots({}, { _deps: deps })
    .catch(() => null)
    .finally(() => {
      cleanupPromises.delete(deps);
    });
  cleanupPromises.set(deps, promise);
  return promise;
}

function remainingMs(deadline) {
  return deadline.expires_at_ms - Date.now();
}

async function withTimeout(label, ms, fn) {
  if (ms <= 0) throw new Error(`${label} budget exhausted`);
  return Promise.race([
    fn(),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

function normalizeStudies(studies = []) {
  const normalized = {};
  for (const study of studies) {
    normalized[study.name] = study.values || {};
  }
  return normalized;
}

function flattenPineLevels(lines = [], boxes = []) {
  const levels = [];
  for (const study of lines) {
    for (const level of study.horizontal_levels || []) {
      levels.push({ kind: 'line', source: study.name, value: level });
    }
  }
  for (const study of boxes) {
    for (const zone of study.boxes || study.zones || []) {
      if (zone.high != null || zone.low != null) {
        levels.push({ kind: 'zone', source: study.name, high: zone.high, low: zone.low });
      }
    }
  }
  return levels;
}

function summarizeTrend(priceSummary) {
  if (!priceSummary || typeof priceSummary.change !== 'number') return 'Trend unavailable';
  if (priceSummary.change > 0) return `Uptrend over lookback (${priceSummary.change_pct || priceSummary.change})`;
  if (priceSummary.change < 0) return `Downtrend over lookback (${priceSummary.change_pct || priceSummary.change})`;
  return 'Flat trend over lookback';
}

function summarizeMomentum(indicatorState) {
  const studyNames = Object.keys(indicatorState || {});
  const flattened = JSON.stringify(indicatorState || {}).toLowerCase();
  if (flattened.includes('rsi') && flattened.match(/([7-9]\d(\.\d+)?)/)) return 'Momentum elevated';
  if (flattened.includes('rsi') && flattened.match(/\b([12]?\d(\.\d+)?)\b/)) return 'Momentum weak';
  if (studyNames.length === 0) return 'Momentum unavailable';
  return 'Momentum mixed';
}

function summarizeStructure(priceSummary, keyLevels = []) {
  if (!priceSummary) return 'Structure unavailable';
  const close = priceSummary.close;
  const nearby = keyLevels
    .map(level => level.value ?? level.high ?? level.low)
    .filter(level => typeof level === 'number')
    .sort((a, b) => Math.abs(a - close) - Math.abs(b - close))
    .slice(0, 3);
  if (nearby.length === 0) return 'No explicit structure levels available';
  return `Nearest structure levels: ${nearby.join(', ')}`;
}

function summarizeCrossTimeframe(entries) {
  const trends = entries.map(entry => entry.trend_summary);
  const bullish = trends.filter(t => t.startsWith('Uptrend')).length;
  const bearish = trends.filter(t => t.startsWith('Downtrend')).length;
  const alignment = bullish === trends.length || bearish === trends.length ? 'aligned' : 'mixed';
  const dominantTrend = bullish > bearish ? 'bullish' : bearish > bullish ? 'bearish' : 'mixed';
  const invalidation = [];
  const confirmation = [];
  for (const entry of entries) {
    for (const level of entry.key_levels || []) {
      if (typeof level.value === 'number') {
        if (level.value < entry.price_summary.close) invalidation.push(level.value);
        if (level.value > entry.price_summary.close) confirmation.push(level.value);
      }
    }
  }
  return {
    alignment,
    dominant_trend: dominantTrend,
    main_invalidation_levels: [...new Set(invalidation)].slice(0, 5),
    main_confirmation_levels: [...new Set(confirmation)].slice(0, 5),
  };
}

async function withCache(cache, key, producer, provenance) {
  if (cache.has(key)) {
    provenance.cache_hits.push(key);
    return cache.get(key);
  }
  const value = await producer();
  cache.set(key, value);
  return value;
}

async function ensureSymbol(symbol, deps, provenance, warnings = []) {
  const normalization = await withCache(
    deps._cache,
    `symbol-normalize:${symbol}`,
    () => normalizeSymbol({ symbol }, { _deps: { chart: deps.chart } }),
    provenance,
  );

  const candidates = [
    normalization?.resolved_symbol,
    symbol,
    ...(normalization?.alternates || []),
  ].filter(Boolean);
  let lastActual = '';

  for (const candidate of [...new Set(candidates)]) {
    provenance.underlying_tools.push('chart_set_symbol');
    const result = await deps.chart.setSymbol({ symbol: candidate });
    if (!result?.success) continue;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      provenance.underlying_tools.push('chart_get_state');
      const state = await deps.chart.getState();
      const actual = state?.symbol || '';
      lastActual = actual;
      if (symbolsMatch(candidate, actual) || symbolsMatch(symbol, actual)) {
        if (normalization?.success && normalization.resolved_symbol && !symbolsMatch(symbol, normalization.resolved_symbol)) {
          warnings.push({
            code: 'symbol_normalized',
            requested_symbol: symbol,
            resolved_symbol: actual,
            confidence: normalization.confidence,
            resolution_method: normalization.resolution_method,
          });
        }
        return {
          success: true,
          requested_symbol: symbol,
          resolved_symbol: actual,
          normalization,
        };
      }
      await new Promise(resolve => setTimeout(resolve, 400));
    }
  }

  throw new Error(`Symbol did not become active on chart: requested ${symbol}${lastActual ? `, last active ${lastActual}` : ''}`);
}

async function ensureTimeframe(timeframe, deps, provenance) {
  provenance.underlying_tools.push('chart_set_timeframe');
  const result = await deps.chart.setTimeframe({ timeframe });
  if (!result?.success) throw new Error(`Could not set timeframe ${timeframe}`);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    provenance.underlying_tools.push('chart_get_state');
    const state = await deps.chart.getState();
    const actual = String(state?.resolution || '');
    if (actual === String(timeframe) || actual === `1${timeframe}` || actual === timeframe.replace(/^1/, '')) return result;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`Timeframe did not become active on chart: requested ${timeframe}`);
}

async function applyStudyPreset(studyPreset, deps, provenance, warnings) {
  if (!studyPreset || studyPreset === 'none' || studyPreset === 'levels_only') return;
  provenance.underlying_tools.push('chart_get_state');
  const state = await deps.chart.getState();
  const activeStudies = new Set((state.studies || []).map(study => study.name));
  for (const spec of STUDY_PRESETS[studyPreset] || []) {
    if (activeStudies.has(spec.name)) continue;
    try {
      provenance.underlying_tools.push('chart_manage_indicator');
      await deps.chart.manageIndicator({
        action: 'add',
        indicator: spec.name,
        inputs: spec.inputs,
      });
    } catch (err) {
      warnings.push({
        code: 'study_preset_partial',
        message: `Could not apply ${spec.name} for preset ${studyPreset}`,
        detail: err.message,
      });
    }
  }
}

async function getTimeframeContext(input, deps, provenance, warnings) {
  const pineEnabled = input.include_pine_context;
  const priceSummary = await withCache(
    deps._cache,
    `ohlcv:${input.symbol}:${input.timeframe}:${input.lookback_bars}`,
    async () => {
      provenance.underlying_tools.push('data_get_ohlcv');
      return deps.data.getOhlcv({ count: input.lookback_bars, summary: true });
    },
    provenance,
  );

  const indicatorState = await withCache(
    deps._cache,
    `study_values:${input.symbol}:${input.timeframe}:${input.study_preset}`,
    async () => {
      provenance.underlying_tools.push('data_get_study_values');
      const studies = await deps.data.getStudyValues();
      return normalizeStudies(studies.studies || []);
    },
    provenance,
  );

  let lines = [];
  let labels = [];
  let tables = [];
  let boxes = [];
  if (pineEnabled) {
    try {
      provenance.underlying_tools.push('data_get_pine_lines');
      const lineResult = await deps.data.getPineLines({});
      lines = lineResult.studies || [];
    } catch (err) {
      warnings.push({ code: 'pine_lines_unavailable', message: err.message });
    }
    try {
      provenance.underlying_tools.push('data_get_pine_labels');
      const labelResult = await deps.data.getPineLabels({});
      labels = (labelResult.studies || []).flatMap(study => study.labels || []);
    } catch (err) {
      warnings.push({ code: 'pine_labels_unavailable', message: err.message });
    }
    try {
      provenance.underlying_tools.push('data_get_pine_tables');
      const tableResult = await deps.data.getPineTables({});
      tables = (tableResult.studies || []).flatMap(study => study.tables || []);
    } catch (err) {
      warnings.push({ code: 'pine_tables_unavailable', message: err.message });
    }
    try {
      provenance.underlying_tools.push('data_get_pine_boxes');
      const boxResult = await deps.data.getPineBoxes({});
      boxes = boxResult.studies || [];
    } catch (err) {
      warnings.push({ code: 'pine_boxes_unavailable', message: err.message });
    }
  }

  const keyLevels = flattenPineLevels(lines, boxes);
  return {
    price_summary: priceSummary,
    indicator_state: indicatorState,
    key_levels: keyLevels,
    labels,
    tables,
    trend_summary: summarizeTrend(priceSummary),
    momentum_summary: summarizeMomentum(indicatorState),
    structure_summary: summarizeStructure(priceSummary, keyLevels),
  };
}

function classifyLeaders(items, topCount, direction = 'desc') {
  const sorted = [...items].sort((a, b) => direction === 'desc' ? b.return_pct - a.return_pct : a.return_pct - b.return_pct);
  return sorted.slice(0, topCount);
}

function regroupByClass(quotes) {
  const grouped = {};
  for (const quote of quotes) {
    if (!grouped[quote.group]) grouped[quote.group] = [];
    grouped[quote.group].push(quote);
  }
  return grouped;
}

async function getSymbolSnapshot(symbol, group, deps, provenance) {
  const provider = deps.marketData.getSymbolSnapshot;
  const key = `snapshot:${symbol}`;
  return withCache(deps._cache, key, async () => {
    if (provider) {
      provenance.underlying_tools.push('market_data_provider.getSymbolSnapshot');
      return provider({ symbol, group });
    }
    await ensureSymbol(symbol, deps, provenance);
    provenance.underlying_tools.push('data_get_ohlcv');
    const ohlcv = await deps.data.getOhlcv({ count: 2, summary: true });
    return {
      symbol,
      group,
      last: ohlcv.close,
      previous_close: ohlcv.open,
      return_pct: Number.parseFloat(String(ohlcv.change_pct).replace('%', '')) || 0,
      source: 'tradingview_chart',
    };
  }, provenance);
}

function round(value, digits = 2) {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function pctChange(from, to) {
  if (![from, to].every(value => typeof value === 'number') || from === 0) return null;
  return round(((to - from) / from) * 100, 2);
}

function pointChange(from, to) {
  if (![from, to].every(value => typeof value === 'number')) return null;
  return round(to - from, 3);
}

function buildCheckpointConfig(sessionWindow) {
  return {
    premarket: { timestamp: sessionWindow.premarket_last, rankingField: 'move_into_open_pct' },
    open: { timestamp: sessionWindow.open, rankingField: null },
    open_30m: { timestamp: sessionWindow.open_30m, rankingField: 'return_from_open_pct' },
    midday: { timestamp: sessionWindow.midday, rankingField: 'return_from_open_pct' },
    close: { timestamp: sessionWindow.close, rankingField: 'return_from_open_pct' },
  };
}

function buildCheckpointCoverage(checkpointBars) {
  return Object.fromEntries(
    Object.entries(checkpointBars).map(([name, bar]) => [name, Boolean(bar)]),
  );
}

function formatOffsetLabel(tzName) {
  if (!tzName) return '+00:00';
  const normalized = tzName.replace('GMT', '').replace('UTC', '') || '+0';
  const sign = normalized.startsWith('-') ? '-' : '+';
  const raw = normalized.replace(/^[+-]/, '');
  const [hours, minutes = '0'] = raw.split(':');
  return `${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function formatZonedIso(timestamp, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'shortOffset',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(timestamp * 1000))
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${formatOffsetLabel(parts.timeZoneName)}`;
}

function parseDateParts(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return { year, month, day };
}

function getZonedTimestamp(dateStr, timeZone, hour, minute) {
  const { year, month, day } = parseDateParts(dateStr);
  const desired = { year, month, day, hour, minute, second: 0 };
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(guess))
        .filter(part => part.type !== 'literal')
        .map(part => [part.type, Number(part.value)]),
    );
    const observedUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const desiredUtc = Date.UTC(
      desired.year,
      desired.month - 1,
      desired.day,
      desired.hour,
      desired.minute,
      desired.second,
    );
    const delta = desiredUtc - observedUtc;
    if (delta === 0) break;
    guess += delta;
  }
  return Math.floor(guess / 1000);
}

function getSessionWindow(sessionDate, region) {
  if (region !== 'US') throw new Error(`Unsupported region for session reconstruction: ${region}`);

  return {
    timezone: 'America/New_York',
    premarket_start: getZonedTimestamp(sessionDate, 'America/New_York', 4, 0),
    premarket_last: getZonedTimestamp(sessionDate, 'America/New_York', 9, 25),
    open: getZonedTimestamp(sessionDate, 'America/New_York', 9, 30),
    open_30m: getZonedTimestamp(sessionDate, 'America/New_York', 10, 0),
    midday: getZonedTimestamp(sessionDate, 'America/New_York', 12, 0),
    close: getZonedTimestamp(sessionDate, 'America/New_York', 15, 55),
  };
}

function filterBarsForSession(bars, sessionDate, timeZone = 'UTC') {
  return bars.filter(bar => sessionDateForBar(bar.time, timeZone) === sessionDate);
}

function sessionDateForBar(timestamp, timeZone) {
  return formatZonedIso(timestamp, timeZone).slice(0, 10);
}

function collectAvailableSessionDates(bars, timeZone) {
  return [...new Set(bars.map(bar => sessionDateForBar(bar.time, timeZone)))].sort();
}

function resolveSessionDate(bars, requestedSessionDate, timeZone) {
  const exactBars = filterBarsForSession(bars, requestedSessionDate, timeZone);
  if (exactBars.length > 0) {
    return {
      requested_session_date: requestedSessionDate,
      resolved_session_date: requestedSessionDate,
      bars: exactBars,
      fallback_used: false,
      available_session_dates: collectAvailableSessionDates(bars, timeZone),
    };
  }

  const availableSessionDates = collectAvailableSessionDates(bars, timeZone);
  if (availableSessionDates.length === 0) {
    return {
      requested_session_date: requestedSessionDate,
      resolved_session_date: null,
      bars: [],
      fallback_used: false,
      available_session_dates: [],
    };
  }

  const priorOrEqual = availableSessionDates.filter(date => date <= requestedSessionDate);
  const resolvedSessionDate = priorOrEqual.at(-1) || availableSessionDates.at(-1);
  return {
    requested_session_date: requestedSessionDate,
    resolved_session_date: resolvedSessionDate,
    bars: filterBarsForSession(bars, resolvedSessionDate, timeZone),
    fallback_used: resolvedSessionDate !== requestedSessionDate,
    available_session_dates: availableSessionDates,
  };
}

function getBarAtOrBefore(bars, timestamp) {
  let selected = null;
  for (const bar of bars) {
    if (bar.time <= timestamp) selected = bar;
    if (bar.time > timestamp) break;
  }
  return selected;
}

function classifySessionPath(openReturn, middayReturn, closeReturn) {
  if ([openReturn, middayReturn, closeReturn].some(value => value == null)) return 'unclassified';
  if (middayReturn > 0.4 && closeReturn < -0.2) return 'reversal_down';
  if (middayReturn < -0.4 && closeReturn > 0.2) return 'reversal_up';
  if (closeReturn > 0.5 && openReturn >= 0) return 'trend_up';
  if (closeReturn < -0.5 && openReturn <= 0) return 'trend_down';
  return 'range_or_mixed';
}

function classifyCloseQuality(closePosition) {
  if (closePosition == null) return 'unknown';
  if (closePosition >= 0.8) return 'closed_near_highs';
  if (closePosition <= 0.2) return 'closed_near_lows';
  return 'closed_mid_range';
}

function summarizeCheckpoint(checkpoint, symbolPackets) {
  const available = symbolPackets
    .filter(packet => packet.checkpoints[checkpoint]?.available)
    .map(packet => ({
      symbol: packet.symbol,
      group: packet.group,
      return_pct: checkpoint === 'premarket'
        ? packet.checkpoints[checkpoint].move_into_open_pct
        : packet.checkpoints[checkpoint].return_from_open_pct,
    }))
    .sort((a, b) => (b.return_pct ?? -Infinity) - (a.return_pct ?? -Infinity));

  return {
    checkpoint,
    status: available.length > 0 ? 'available' : 'missing',
    available_symbol_count: available.length,
    leaders: available.slice(0, 3),
    laggards: [...available].reverse().slice(0, 3).reverse(),
  };
}

function buildCheckpointRankings(checkpoints, symbolPackets) {
  const rankings = {};
  const ranksBySymbol = {};
  for (const packet of symbolPackets) ranksBySymbol[packet.symbol] = {};

  for (const checkpoint of checkpoints) {
    const ranked = symbolPackets
      .map(packet => ({
        symbol: packet.symbol,
        group: packet.group,
        return_pct: checkpoint === 'premarket'
          ? packet.checkpoints[checkpoint]?.move_into_open_pct
          : checkpoint === 'open'
            ? 0
            : packet.checkpoints[checkpoint]?.return_from_open_pct,
      }))
      .filter(row => row.return_pct != null)
      .sort((a, b) => b.return_pct - a.return_pct)
      .map((row, index) => ({ ...row, rank: index + 1 }));

    rankings[checkpoint] = ranked;
    for (const row of ranked) ranksBySymbol[row.symbol][checkpoint] = row.rank;
  }

  return { rankings, ranksBySymbol };
}

function buildRelativeStrengthSpreads(symbolPackets, checkpoints, baseSymbol = 'SPY') {
  const base = symbolPackets.find(packet => packet.symbol === baseSymbol);
  if (!base) return [];

  const spreads = [];
  for (const packet of symbolPackets) {
    if (packet.symbol === baseSymbol) continue;
    const spreadPct = {};
    for (const checkpoint of checkpoints) {
      const left = checkpoint === 'premarket'
        ? packet.checkpoints[checkpoint]?.move_into_open_pct
        : checkpoint === 'open'
          ? 0
          : packet.checkpoints[checkpoint]?.return_from_open_pct;
      const right = checkpoint === 'premarket'
        ? base.checkpoints[checkpoint]?.move_into_open_pct
        : checkpoint === 'open'
          ? 0
          : base.checkpoints[checkpoint]?.return_from_open_pct;
      spreadPct[checkpoint] = left != null && right != null ? round(left - right, 2) : null;
    }
    spreads.push({
      name: `${packet.symbol}_minus_${baseSymbol}`,
      left: packet.symbol,
      right: baseSymbol,
      spread_pct: spreadPct,
    });
  }
  return spreads;
}

async function getSessionSymbolPacket(symbol, group, input, deps, provenance, warnings) {
  const cacheKey = `session-bars:${symbol}:5:${input.session_date}:${input.region}`;
  const sessionWindow = getSessionWindow(input.session_date, input.region);
  const bars = await withCache(deps._cache, cacheKey, async () => {
    await ensureSymbol(symbol, deps, provenance, warnings);
    await ensureTimeframe('5', deps, provenance);
    if (deps.chart.scrollToDate) {
      try {
        provenance.underlying_tools.push('chart_scroll_to_date');
        await deps.chart.scrollToDate({ date: input.session_date });
      } catch (err) {
        warnings.push({ code: 'session_scroll_failed', symbol, message: err.message });
      }
    }
    provenance.underlying_tools.push('data_get_ohlcv');
    const result = await deps.data.getOhlcv({ count: 500, summary: false });
    return result.bars || [];
  }, provenance);
  provenance.underlying_tools.push('chart_get_state');
  const chartState = await deps.chart.getState();

  const resolvedSession = resolveSessionDate(bars, input.session_date, sessionWindow.timezone);
  const dailyBars = resolvedSession.bars;
  if (dailyBars.length === 0) {
    throw new Error(`No bars available for ${symbol} around ${input.session_date}`);
  }
  const effectiveSessionDate = resolvedSession.resolved_session_date;
  const effectiveSessionWindow = getSessionWindow(effectiveSessionDate, input.region);
  if (resolvedSession.fallback_used) {
    warnings.push({
      code: 'session_date_fallback',
      symbol,
      requested_session_date: input.session_date,
      resolved_session_date: effectiveSessionDate,
      message: `No bars were available for ${symbol} on ${input.session_date}; used nearest available session ${effectiveSessionDate}`,
    });
  }

  const priorBars = bars.filter(bar => bar.time < effectiveSessionWindow.open);
  const regularBars = dailyBars.filter(bar => bar.time >= effectiveSessionWindow.open && bar.time <= effectiveSessionWindow.close);
  const premarketBars = dailyBars.filter(bar => bar.time >= effectiveSessionWindow.premarket_start && bar.time < effectiveSessionWindow.open);
  const workingBars = regularBars.length > 0 ? regularBars : dailyBars;
  const openBar = workingBars[0];
  const closeBar = workingBars.at(-1);
  const priorCloseBar = priorBars.at(-1) || null;
  const checkpointBars = {
    premarket: getBarAtOrBefore(premarketBars, effectiveSessionWindow.premarket_last) || premarketBars.at(-1) || null,
    open: getBarAtOrBefore(workingBars, effectiveSessionWindow.open) || openBar,
    open_30m: getBarAtOrBefore(workingBars, effectiveSessionWindow.open_30m),
    midday: getBarAtOrBefore(workingBars, effectiveSessionWindow.midday),
    close: closeBar || null,
  };

  const sessionHigh = Math.max(...workingBars.map(bar => bar.high));
  const sessionLow = Math.min(...workingBars.map(bar => bar.low));
  const totalVolume = workingBars.reduce((sum, bar) => sum + (bar.volume || 0), 0);
  const vwapNumerator = workingBars.reduce((sum, bar) => sum + ((((bar.high + bar.low + bar.close) / 3) * (bar.volume || 0))), 0);
  const sessionVwap = totalVolume > 0 ? vwapNumerator / totalVolume : null;
  const closePosition = sessionHigh === sessionLow ? 0.5 : (closeBar.close - sessionLow) / (sessionHigh - sessionLow);
  const openReturn = pctChange(openBar.open, getBarAtOrBefore(workingBars, effectiveSessionWindow.open_30m)?.close ?? openBar.close);
  const middayReturn = pctChange(openBar.open, checkpointBars.midday?.close ?? closeBar.close);
  const closeReturn = pctChange(openBar.open, closeBar.close);
  const sessionHighBar = workingBars.reduce((best, bar) => (!best || bar.high >= best.high ? bar : best), null);
  const sessionLowBar = workingBars.reduce((best, bar) => (!best || bar.low <= best.low ? bar : best), null);
  const maxExcursionUpPct = pctChange(openBar.open, sessionHigh);
  const maxExcursionDownPct = pctChange(openBar.open, sessionLow);
  const resolvedSymbol = chartState?.symbol || symbol;
  const exchange = String(resolvedSymbol).includes(':') ? String(resolvedSymbol).split(':')[0] : null;
  let screenshotPath = null;
  try {
    provenance.underlying_tools.push('capture_screenshot');
    const shot = await deps.capture.captureScreenshot({
      region: 'chart',
      filename: `session_${symbol}_${input.session_date}_${Date.now()}`,
    });
    screenshotPath = shot?.file_path || null;
  } catch (err) {
    warnings.push({ code: 'session_screenshot_failed', symbol, message: err.message });
  }

  return {
    symbol,
    group,
    source: 'tradingview_intraday_bars',
    requested_symbol: symbol,
    resolved_symbol: resolvedSymbol,
    feed_exchange: exchange,
    bar_timeframe: '5',
    timezone: effectiveSessionWindow.timezone,
    requested_session_date: input.session_date,
    resolved_session_date: effectiveSessionDate,
    available_session_dates: resolvedSession.available_session_dates,
    regular_session_bar_count: regularBars.length,
    available_bar_count: dailyBars.length,
    session_range: {
      high: round(sessionHigh, 3),
      low: round(sessionLow, 3),
    },
    return_pct: closeReturn,
    path: classifySessionPath(openReturn, middayReturn, closeReturn),
    close_quality: classifyCloseQuality(closePosition),
    close_position_pct: round(closePosition * 100, 1),
    prior_close_price: round(priorCloseBar?.close ?? null, 3),
    checkpoints: {
      premarket: {
        available: Boolean(checkpointBars.premarket),
        timestamp: checkpointBars.premarket?.time ?? null,
        price: checkpointBars.premarket?.close ?? null,
        return_from_open_pct: null,
        move_into_open_pct: checkpointBars.premarket ? pctChange(checkpointBars.premarket.close, openBar.open) : null,
      },
      open: {
        available: Boolean(checkpointBars.open),
        timestamp: checkpointBars.open?.time ?? null,
        price: checkpointBars.open?.open ?? checkpointBars.open?.close ?? null,
        return_from_open_pct: 0,
      },
      open_30m: {
        available: Boolean(checkpointBars.open_30m),
        timestamp: checkpointBars.open_30m?.time ?? null,
        price: checkpointBars.open_30m?.close ?? null,
        return_from_open_pct: checkpointBars.open_30m ? pctChange(openBar.open, checkpointBars.open_30m.close) : null,
      },
      midday: {
        available: Boolean(checkpointBars.midday),
        timestamp: checkpointBars.midday?.time ?? null,
        price: checkpointBars.midday?.close ?? null,
        return_from_open_pct: checkpointBars.midday ? pctChange(openBar.open, checkpointBars.midday.close) : null,
      },
      close: {
        available: Boolean(checkpointBars.close),
        timestamp: checkpointBars.close?.time ?? null,
        price: checkpointBars.close?.close ?? null,
        return_from_open_pct: checkpointBars.close ? pctChange(openBar.open, checkpointBars.close.close) : null,
      },
    },
    open_price: round(openBar.open, 3),
    close_price: round(closeBar.close, 3),
    opening_context: {
      prior_close: round(priorCloseBar?.close ?? null, 3),
      premarket_last: round(checkpointBars.premarket?.close ?? null, 3),
      open: round(openBar.open, 3),
      gap_from_prior_close_pct: priorCloseBar ? pctChange(priorCloseBar.close, openBar.open) : null,
      premarket_to_open_pct: checkpointBars.premarket ? pctChange(checkpointBars.premarket.close, openBar.open) : null,
      opening_30m_move_pct: checkpointBars.open_30m ? pctChange(openBar.open, checkpointBars.open_30m.close) : null,
      opening_pattern: openReturn == null ? 'unknown' : openReturn > 0.35 ? 'opening_drive_up' : openReturn < -0.35 ? 'opening_drive_down' : 'opening_balance',
    },
    session_structure: {
      high: round(sessionHigh, 3),
      low: round(sessionLow, 3),
      high_timestamp: sessionHighBar ? formatZonedIso(sessionHighBar.time, effectiveSessionWindow.timezone) : null,
      low_timestamp: sessionLowBar ? formatZonedIso(sessionLowBar.time, effectiveSessionWindow.timezone) : null,
      close: round(closeBar.close, 3),
      close_vs_session_high_pct: pctChange(sessionHigh, closeBar.close),
      close_vs_session_low_pct: pctChange(sessionLow, closeBar.close),
      close_location_pct: round(closePosition * 100, 1),
      intraday_pattern: classifySessionPath(openReturn, middayReturn, closeReturn),
      close_vs_vwap_pct: sessionVwap ? pctChange(sessionVwap, closeBar.close) : null,
    },
    range_stats: {
      session_range_points: round(sessionHigh - sessionLow, 3),
      session_range_pct_of_open: pctChange(openBar.open, sessionHigh) != null && pctChange(openBar.open, sessionLow) != null
        ? round(((sessionHigh - sessionLow) / openBar.open) * 100, 2)
        : null,
      open_to_close_pct: closeReturn,
      max_excursion_up_pct: maxExcursionUpPct,
      max_excursion_down_pct: maxExcursionDownPct,
    },
    data_quality: {
      requested_symbol: symbol,
      resolved_symbol: resolvedSymbol,
      feed_exchange: exchange,
      bar_timeframe: '5',
      requested_session_date: input.session_date,
      resolved_session_date: effectiveSessionDate,
      session_date_fallback_used: resolvedSession.fallback_used,
      available_session_dates: resolvedSession.available_session_dates,
      extended_hours_requested: true,
      extended_hours_observed: premarketBars.length > 0,
      checkpoint_coverage: buildCheckpointCoverage(checkpointBars),
      bar_count_total: dailyBars.length,
      screenshot_path: screenshotPath,
      coverage_confidence: ['premarket', 'open', 'open_30m', 'midday', 'close'].every(name => Boolean(checkpointBars[name]))
        ? 'high'
        : ['open', 'open_30m', 'midday', 'close'].every(name => Boolean(checkpointBars[name]))
          ? 'medium'
          : 'low',
    },
    screenshot_path: screenshotPath,
  };
}

function reactionTemplate(name) {
  const templates = {
    risk_on: {
      winners: ['SPY', 'QQQ', 'BTCUSD'],
      losers: ['TLT', 'GLD', 'VIX'],
      behavior_notes: ['Equities and beta should outperform defensive hedges', 'Volatility should soften'],
    },
    risk_off: {
      winners: ['TLT', 'GLD', 'VIX'],
      losers: ['SPY', 'QQQ', 'BTCUSD'],
      behavior_notes: ['Defensive assets should bid', 'Risk assets should lag or reverse'],
    },
  };
  return templates[name] || {
    winners: [],
    losers: [],
    behavior_notes: [`No canned template for ${name}`],
  };
}

export async function cleanupStaleScreenshots(args = {}, { _deps } = {}) {
  const input = cleanupScreenshotsInputSchema.parse(args);
  const deps = resolveDeps(_deps);
  const now = deps.now();
  const screenshotDir = input.screenshot_dir || deps.screenshotDir;
  const maxAgeMs = input.max_age_hours * 60 * 60 * 1000;
  const warnings = [];
  const removedFiles = [];
  let scannedFiles = 0;

  try {
    const entries = await deps.fileSystem.readdir(screenshotDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.png')) continue;
      scannedFiles += 1;
      const filePath = join(screenshotDir, entry.name);
      try {
        const stats = await deps.fileSystem.stat(filePath);
        const ageAnchorMs = getFileAgeAnchorMs(stats);
        if (ageAnchorMs == null) {
          warnings.push({ code: 'cleanup_stat_unsupported', file_path: filePath, message: 'Could not determine screenshot age' });
          continue;
        }
        if ((now.getTime() - ageAnchorMs) > maxAgeMs) {
          await deps.fileSystem.rm(filePath, { force: true });
          removedFiles.push(filePath);
        }
      } catch (err) {
        warnings.push({ code: 'cleanup_file_failed', file_path: filePath, message: err.message });
      }
    }
  } catch (err) {
    if (err?.code === 'ENOENT') {
      warnings.push({ code: 'screenshot_dir_missing', directory: screenshotDir, message: 'Screenshot directory does not exist' });
    } else {
      return envelope({
        packetType: 'cleanup_stale_screenshots',
        data: {
          screenshot_dir: screenshotDir,
          max_age_hours: input.max_age_hours,
          scanned_files: scannedFiles,
          removed_files: removedFiles,
        },
        errors: [{ code: 'cleanup_failed', message: err.message }],
        warnings,
        partialResults: false,
        now,
      });
    }
  }

  return envelope({
    packetType: 'cleanup_stale_screenshots',
    data: {
      screenshot_dir: screenshotDir,
      max_age_hours: input.max_age_hours,
      scanned_files: scannedFiles,
      removed_files: removedFiles,
    },
    warnings,
    partialResults: warnings.length > 0,
    now,
  });
}

async function detectOverlayOcclusion(deps) {
  try {
    const result = await deps.evaluate(`
      (function() {
        var selectors = [
          '[aria-modal="true"]',
          '[role="dialog"]',
          '[class*="modal"]',
          '[class*="dialog"]',
          '[class*="popup"]',
          '[data-name="gopro"]',
          '[class*="marketing"]'
        ];
        var hits = [];
        for (var i = 0; i < selectors.length; i++) {
          var nodes = document.querySelectorAll(selectors[i]);
          for (var j = 0; j < nodes.length; j++) {
            var el = nodes[j];
            var style = window.getComputedStyle(el);
            var rect = el.getBoundingClientRect();
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) continue;
            if (rect.width < 40 || rect.height < 40) continue;
            hits.push({
              selector: selectors[i],
              text: (el.textContent || '').trim().slice(0, 120),
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            });
          }
        }
        return { found: hits.length > 0, overlays: hits.slice(0, 5) };
      })()
    `);
    return result || { found: false, overlays: [] };
  } catch (err) {
    return { found: false, overlays: [], error: err.message };
  }
}

function summarizeStaleness(lastTimestamp, now, staleAfterSeconds) {
  if (!lastTimestamp) {
    return {
      stale: true,
      age_seconds: null,
      reason: 'missing_last_bar_time',
    };
  }
  const ageSeconds = Math.max(0, Math.round((now.getTime() - (lastTimestamp * 1000)) / 1000));
  return {
    stale: ageSeconds > staleAfterSeconds,
    age_seconds: ageSeconds,
    reason: ageSeconds > staleAfterSeconds ? 'age_exceeded_threshold' : 'fresh',
  };
}

export async function symbolNormalize(args, { _deps } = {}) {
  const input = symbolNormalizeInputSchema.parse(args);
  const deps = resolveDeps(_deps);
  scheduleStaleScreenshotCleanup(deps);
  const now = deps.now();
  const normalization = await normalizeSymbol({ symbol: input.symbol }, { _deps: { chart: deps.chart } });

  return envelope({
    packetType: 'symbol_normalize',
    data: normalization,
    errors: normalization.success ? [] : [{ code: 'symbol_unresolved', message: normalization.error || `Could not normalize ${input.symbol}` }],
    warnings: [],
    partialResults: !normalization.success,
    now,
    provenance: {
      sources: ['tradingview-mcp'],
      underlying_tools: ['symbol_search'],
      cache_hits: [],
      symbols: [input.symbol],
    },
  });
}

export async function dataQualityReport(args, { _deps } = {}) {
  const input = dataQualityReportInputSchema.parse(args);
  const deps = resolveDeps(_deps);
  scheduleStaleScreenshotCleanup(deps);
  const now = deps.now();
  const warnings = [];
  const errors = [];
  const provenance = {
    sources: ['tradingview-mcp'],
    underlying_tools: [],
    cache_hits: [],
    symbols: input.symbols,
    timeframes: [input.timeframe],
  };

  const overlayState = await detectOverlayOcclusion(deps);
  if (overlayState.found) {
    warnings.push({
      code: 'overlay_detected',
      message: 'TradingView overlay or modal is visible and may contaminate screenshots',
      overlays: overlayState.overlays,
    });
  }

  const perSymbol = [];
  for (const symbol of input.symbols) {
    const row = {
      requested_symbol: symbol,
      resolved_symbol: null,
      normalization: null,
      chart_state_match: false,
      quote_available: false,
      stale_data: null,
      premarket_available: null,
      contamination_risk: 'unknown',
      issues: [],
    };
    try {
      const normalization = await withCache(
        deps._cache,
        `symbol-normalize:${symbol}`,
        () => normalizeSymbol({ symbol }, { _deps: { chart: deps.chart } }),
        provenance,
      );
      row.normalization = {
        confidence: normalization.confidence,
        resolution_method: normalization.resolution_method,
        alternates: normalization.alternates,
      };
      row.resolved_symbol = normalization.resolved_symbol;
      if (!normalization.success) {
        row.issues.push({ code: 'symbol_unresolved', message: normalization.error || `Could not normalize ${symbol}` });
        row.contamination_risk = 'high';
        perSymbol.push(row);
        continue;
      }

      await ensureSymbol(symbol, deps, provenance, warnings);
      await ensureTimeframe(input.timeframe, deps, provenance);
      provenance.underlying_tools.push('chart_get_state');
      const state = await deps.chart.getState();
      row.chart_state_match = symbolsMatch(symbol, state?.symbol) || symbolsMatch(normalization.resolved_symbol, state?.symbol);
      row.resolved_symbol = state?.symbol || normalization.resolved_symbol;

      provenance.underlying_tools.push('quote_get');
      const quote = await deps.data.getQuote({ symbol });
      row.quote_available = true;
      row.stale_data = summarizeStaleness(quote.time, now, input.stale_after_seconds);

      provenance.underlying_tools.push('data_get_ohlcv');
      const barResult = await deps.data.getOhlcv({ count: input.lookback_bars, summary: false });
      const bars = barResult.bars || [];
      if (input.region === 'US' && bars.length > 0) {
        const latestSessionDate = sessionDateForBar(bars.at(-1).time, 'America/New_York');
        const sessionWindow = getSessionWindow(latestSessionDate, 'US');
        row.premarket_available = bars.some(bar => bar.time >= sessionWindow.premarket_start && bar.time < sessionWindow.open);
      }

      row.contamination_risk = row.chart_state_match ? 'low' : 'high';
      if (!row.chart_state_match) {
        row.issues.push({
          code: 'chart_state_mismatch',
          message: `Active chart ${state?.symbol || 'unknown'} did not match requested symbol ${symbol}`,
        });
      }
      if (row.stale_data?.stale) {
        row.issues.push({
          code: 'stale_data',
          message: `Last bar age ${row.stale_data.age_seconds}s exceeded threshold ${input.stale_after_seconds}s`,
        });
      }
      if (overlayState.found) {
        row.issues.push({
          code: 'overlay_detected',
          message: 'Visible overlay may occlude screenshots',
        });
      }
    } catch (err) {
      row.contamination_risk = 'high';
      row.issues.push({ code: 'data_quality_check_failed', message: err.message });
    }
    perSymbol.push(row);
  }

  return envelope({
    packetType: 'data_quality_report',
    data: {
      timeframe: input.timeframe,
      stale_after_seconds: input.stale_after_seconds,
      overlay_state: overlayState,
      symbols: perSymbol,
      summary: {
        requested_symbol_count: input.symbols.length,
        resolved_symbol_count: perSymbol.filter(item => item.resolved_symbol).length,
        high_risk_symbols: perSymbol.filter(item => item.contamination_risk === 'high').map(item => item.requested_symbol),
        stale_symbols: perSymbol.filter(item => item.stale_data?.stale).map(item => item.requested_symbol),
      },
    },
    errors,
    warnings,
    partialResults: warnings.length > 0 || perSymbol.some(item => item.issues.length > 0),
    now,
    provenance,
  });
}

async function getHeadlineResponse(symbol, input, deps, provenance) {
  const provider = deps.marketData.getHeadlineWindowResponse;
  if (!provider) {
    return {
      symbol,
      immediate_return_pct: null,
      follow_through_return_pct: null,
      status: 'unavailable',
      note: 'No headline response market-data provider configured',
    };
  }
  provenance.underlying_tools.push('market_data_provider.getHeadlineWindowResponse');
  return provider({
    symbol,
    timestamp: input.timestamp,
    window_minutes_before: input.window_minutes_before,
    window_minutes_after: input.window_minutes_after,
  });
}

function buildVehicleCandidates(topic, regimeView, vehicleClasses, includeDefensive, includeDirectional) {
  const rules = [
    { vehicle: 'SPY', class: 'index', direction: 'long', tags: ['relief', 'risk-on', 'equity'] },
    { vehicle: 'QQQ', class: 'index', direction: 'long', tags: ['growth', 'relief', 'risk-on'] },
    { vehicle: 'IWM', class: 'index', direction: 'long', tags: ['beta', 'domestic', 'risk-on'] },
    { vehicle: 'XLE', class: 'sector', direction: 'long', tags: ['energy', 'commodity', 'geopolitical'] },
    { vehicle: 'XLK', class: 'sector', direction: 'long', tags: ['growth', 'tech', 'leadership'] },
    { vehicle: 'XLF', class: 'sector', direction: 'long', tags: ['rates', 'financials'] },
    { vehicle: 'TLT', class: 'hedge', direction: 'long', tags: ['defensive', 'rates', 'hedge'] },
    { vehicle: 'GLD', class: 'hedge', direction: 'long', tags: ['defensive', 'gold', 'hedge'] },
    { vehicle: 'VIX', class: 'hedge', direction: 'long', tags: ['vol', 'defensive', 'hedge'] },
    { vehicle: 'call_spread_on_QQQ', class: 'options', direction: 'long', tags: ['options', 'risk-on'] },
    { vehicle: 'put_spread_on_SPY', class: 'options', direction: 'short', tags: ['options', 'hedge', 'fragile'] },
  ];
  const blob = `${topic} ${regimeView}`.toLowerCase();
  return rules.filter(rule => {
    if (!vehicleClasses.includes(rule.class)) return false;
    if (!includeDefensive && rule.class === 'hedge') return false;
    if (!includeDirectional && rule.class !== 'hedge') return false;
    return rule.tags.some(tag => blob.includes(tag)) || rule.class === 'hedge';
  });
}

export function resetAnalystCache({ _deps } = {}) {
  getRunCache(_deps).clear();
  return { success: true };
}

export async function buildChartContextPacket(args, { _deps } = {}) {
  const input = chartContextInputSchema.parse(args);
  const deps = resolveDeps(_deps);
  scheduleStaleScreenshotCleanup(deps);
  const warnings = [];
  const errors = [];
  const provenance = {
    sources: ['tradingview-mcp'],
    underlying_tools: [],
    cache_hits: [],
    symbols: [input.symbol],
    timeframes: input.timeframes,
  };
  const now = deps.now();
  const deadline = makeDeadline(Date.now(), CHART_CONTEXT_BUDGET_MS);

  try {
    await ensureSymbol(input.symbol, deps, provenance, warnings);
    await applyStudyPreset(input.study_preset, deps, provenance, warnings);
  } catch (err) {
    return envelope({
      packetType: 'build_chart_context_packet',
      data: { symbol: input.symbol, timeframes: {} },
      errors: [{ code: 'symbol_setup_failed', message: err.message }],
      warnings,
      partialResults: false,
      now,
      provenance,
    });
  }

  const timeframePackets = {};
  const screenshotPaths = [];
  for (const timeframe of input.timeframes) {
    const msLeft = remainingMs(deadline);
    if (msLeft <= 0) {
      warnings.push({ code: 'budget_exhausted', message: 'Chart context budget exhausted before all timeframes completed', remaining_timeframes: input.timeframes.filter(tf => !timeframePackets[tf]) });
      break;
    }
    try {
      await withTimeout(`chart_context:${timeframe}`, Math.min(msLeft, 15000), async () => {
        await ensureTimeframe(timeframe, deps, provenance);
        const packet = await getTimeframeContext({ ...input, timeframe }, deps, provenance, warnings);
        timeframePackets[timeframe] = packet;
      });
      if (input.include_screenshot) {
        try {
          provenance.underlying_tools.push('capture_screenshot');
          const shot = await deps.capture.captureScreenshot({
            region: 'chart',
            filename: `${input.symbol}_${timeframe}_${now.toISOString().replace(/[:.]/g, '-')}`,
          });
          if (shot.file_path) screenshotPaths.push(shot.file_path);
        } catch (err) {
          warnings.push({ code: 'screenshot_failed', message: err.message, timeframe });
        }
      }
    } catch (err) {
      errors.push({ code: 'timeframe_failed', message: err.message, timeframe });
    }
  }

  const completedFrames = Object.values(timeframePackets);
  const partialResults = errors.length > 0 || warnings.some(w => String(w.code).startsWith('pine_') || w.code === 'budget_exhausted');
  return envelope({
    packetType: 'build_chart_context_packet',
    data: {
      symbol: input.symbol,
      captured_at: now.toISOString(),
      timeframes: timeframePackets,
      cross_timeframe_summary: completedFrames.length > 0 ? summarizeCrossTimeframe(completedFrames) : {
        alignment: 'none',
        dominant_trend: '',
        main_invalidation_levels: [],
        main_confirmation_levels: [],
      },
      screenshot_paths: screenshotPaths,
      provenance: {
        source: 'tradingview-mcp',
        tools_used: provenance.underlying_tools,
        study_preset: input.study_preset,
      },
    },
    errors: completedFrames.length === 0 ? errors.length ? errors : [{ code: 'no_timeframes_available', message: 'None of the requested timeframes returned data' }] : errors,
    warnings,
    partialResults,
    now,
    provenance,
  });
}

export async function buildMarketSessionPacket(args, { _deps } = {}) {
  const input = marketSessionInputSchema.parse(args);
  const deps = resolveDeps(_deps);
  scheduleStaleScreenshotCleanup(deps);
  const now = deps.now();
  const warnings = [];
  const errors = [];
  const provenance = {
    sources: ['tradingview-mcp'],
    underlying_tools: [],
    cache_hits: [],
    symbols: [...input.benchmarks, ...input.sectors, ...input.hedges, ...input.optional_symbols],
  };
  const deadline = makeDeadline(Date.now(), HIGH_LEVEL_TOTAL_BUDGET_MS);

  if (input.region !== 'US') {
    return envelope({
      packetType: 'build_market_session_packet',
      data: {
        session_date: input.session_date,
        region: input.region,
        timezone: '',
        bar_timeframe: '5',
        session_definition: { checkpoints: {}, include_extended_hours: true, regular_session_start: '', regular_session_end: '' },
        universe: { benchmarks: [], sectors: [], hedges: [], optional_symbols: [] },
        checkpoint_matrix: [],
        checkpoint_rankings: {},
        relative_strength_spreads: [],
        session_structure: [],
        opening_context: [],
        range_stats: [],
        data_quality: [],
        coverage_summary: {
          requested_symbol_count: 0,
          successful_symbol_count: 0,
          missing_symbols: [],
          premarket_symbols_available: [],
        },
        provenance: { sources: provenance.sources },
      },
      errors: [{ code: 'unsupported_region', message: `Only US session reconstruction is currently supported, received ${input.region}` }],
      warnings,
      partialResults: false,
      now,
      provenance,
    });
  }

  const symbols = [
    ...input.benchmarks.map(symbol => ({ symbol, group: 'benchmarks' })),
    ...input.sectors.map(symbol => ({ symbol, group: 'sectors' })),
    ...input.hedges.map(symbol => ({ symbol, group: 'hedges' })),
    ...input.optional_symbols.map(symbol => ({ symbol, group: 'optional' })),
  ];

  const symbolPackets = [];
  for (const item of symbols) {
    const totalMsLeft = remainingMs(deadline);
    if (totalMsLeft <= 0) {
      warnings.push({
        code: 'budget_exhausted',
        message: 'Session packet budget exhausted before all symbols completed',
        remaining_symbols: symbols.slice(symbolPackets.length).map(entry => entry.symbol),
      });
      break;
    }
    try {
      const perSymbolBudget = Math.max(1500, Math.min(SESSION_SYMBOL_BUDGET_MS, totalMsLeft));
      symbolPackets.push(await withTimeout(
        `session_symbol:${item.symbol}`,
        perSymbolBudget,
        () => getSessionSymbolPacket(item.symbol, item.group, input, deps, provenance, warnings),
      ));
    } catch (err) {
      warnings.push({ code: 'session_symbol_failed', symbol: item.symbol, message: err.message });
    }
  }

  const availableCheckpoints = input.checkpoints.slice(0, Math.max(3, input.checkpoints.length));
  if (input.checkpoints.length < 3) {
    warnings.push({ code: 'checkpoint_count_low', message: 'At least 3 checkpoints are recommended' });
  }
  const resolvedSessionDates = [...new Set(symbolPackets.map(packet => packet.resolved_session_date).filter(Boolean))];
  const packetSessionDate = resolvedSessionDates.length === 1 ? resolvedSessionDates[0] : input.session_date;
  const sessionWindow = getSessionWindow(packetSessionDate, input.region);
  if (resolvedSessionDates.length === 1 && resolvedSessionDates[0] !== input.session_date) {
    warnings.push({
      code: 'session_packet_date_fallback',
      requested_session_date: input.session_date,
      resolved_session_date: resolvedSessionDates[0],
      message: `Requested session ${input.session_date} was unavailable; packet evidence uses ${resolvedSessionDates[0]}`,
    });
  } else if (resolvedSessionDates.length > 1) {
    warnings.push({
      code: 'mixed_resolved_session_dates',
      requested_session_date: input.session_date,
      resolved_session_dates: resolvedSessionDates,
      message: 'Symbols resolved to more than one available session date',
    });
  }
  const checkpointTimestamps = buildCheckpointConfig(sessionWindow);
  const sessionCheckpoints = availableCheckpoints.map(name => summarizeCheckpoint(name, symbolPackets));
  const { rankings, ranksBySymbol } = buildCheckpointRankings(availableCheckpoints, symbolPackets);
  const missingPremarket = symbolPackets.filter(packet => !packet.checkpoints.premarket.available).map(packet => packet.symbol);
  if (missingPremarket.length > 0) {
    warnings.push({
      code: 'premarket_unavailable',
      message: 'Premarket bars were unavailable for some symbols on this chart/feed',
      symbols: missingPremarket.slice(0, 10),
    });
  }
  const checkpointMatrix = symbolPackets.map(packet => ({
    symbol: packet.symbol,
    group: packet.group,
    prices: {
      premarket: packet.checkpoints.premarket.price,
      open: packet.open_price,
      open_30m: packet.checkpoints.open_30m.price,
      midday: packet.checkpoints.midday.price,
      close: packet.checkpoints.close.price,
    },
    returns_pct: {
      premarket_to_open: packet.checkpoints.premarket.move_into_open_pct,
      open_to_open_30m: packet.checkpoints.open_30m.return_from_open_pct,
      open_to_midday: packet.checkpoints.midday.return_from_open_pct,
      open_to_close: packet.checkpoints.close.return_from_open_pct,
      midday_to_close: packet.checkpoints.midday.price != null && packet.checkpoints.close.price != null
        ? pctChange(packet.checkpoints.midday.price, packet.checkpoints.close.price)
        : null,
    },
    returns_points: {
      premarket_to_open: packet.checkpoints.premarket?.price != null ? pointChange(packet.checkpoints.premarket.price, packet.open_price) : null,
      open_to_open_30m: pointChange(packet.open_price, packet.checkpoints.open_30m.price),
      open_to_midday: pointChange(packet.open_price, packet.checkpoints.midday.price),
      open_to_close: pointChange(packet.open_price, packet.checkpoints.close.price),
      midday_to_close: pointChange(packet.checkpoints.midday.price, packet.checkpoints.close.price),
    },
    ranks: {
      premarket: ranksBySymbol[packet.symbol]?.premarket ?? null,
      open_30m: ranksBySymbol[packet.symbol]?.open_30m ?? null,
      midday: ranksBySymbol[packet.symbol]?.midday ?? null,
      close: ranksBySymbol[packet.symbol]?.close ?? null,
    },
  }));
  const relativeStrengthSpreads = buildRelativeStrengthSpreads(symbolPackets, ['open_30m', 'midday', 'close']);
  const sessionStructure = symbolPackets.map(packet => ({
    symbol: packet.symbol,
    group: packet.group,
    ...packet.session_structure,
  }));
  const openingContext = symbolPackets.map(packet => ({
    symbol: packet.symbol,
    group: packet.group,
    ...packet.opening_context,
  }));
  const rangeStats = symbolPackets.map(packet => ({
    symbol: packet.symbol,
    group: packet.group,
    ...packet.range_stats,
  }));
  const dataQuality = symbolPackets.map(packet => packet.data_quality);

  return envelope({
    packetType: 'build_market_session_packet',
    data: {
      requested_session_date: input.session_date,
      resolved_session_date: packetSessionDate,
      session_date: packetSessionDate,
      region: input.region,
      timezone: sessionWindow.timezone,
      bar_timeframe: '5',
      session_definition: {
        checkpoints: Object.fromEntries(
          Object.entries(checkpointTimestamps)
            .filter(([name]) => availableCheckpoints.includes(name))
            .map(([name, config]) => [name, formatZonedIso(config.timestamp, sessionWindow.timezone)]),
        ),
        include_extended_hours: true,
        regular_session_start: formatZonedIso(sessionWindow.open, sessionWindow.timezone),
        regular_session_end: formatZonedIso(sessionWindow.close, sessionWindow.timezone),
      },
      universe: {
        benchmarks: input.benchmarks,
        sectors: input.sectors,
        hedges: input.hedges,
        optional_symbols: input.optional_symbols,
      },
      checkpoint_availability: sessionCheckpoints,
      checkpoint_matrix: checkpointMatrix,
      checkpoint_rankings: rankings,
      relative_strength_spreads: relativeStrengthSpreads,
      session_structure: sessionStructure,
      opening_context: openingContext,
      range_stats: rangeStats,
      data_quality: dataQuality,
      chart_references: symbolPackets
        .filter(packet => packet.screenshot_path)
        .map(packet => ({
          symbol: packet.symbol,
          group: packet.group,
          screenshot_path: packet.screenshot_path,
        })),
      coverage_summary: {
        requested_symbol_count: symbols.length,
        successful_symbol_count: symbolPackets.length,
        missing_symbols: symbols.map(item => item.symbol).filter(symbol => !symbolPackets.some(packet => packet.symbol === symbol)),
        premarket_symbols_available: symbolPackets.filter(packet => packet.checkpoints.premarket.available).map(packet => packet.symbol),
        resolved_session_dates: resolvedSessionDates,
        checkpoint_counts: Object.fromEntries(
          availableCheckpoints.map(name => [name, symbolPackets.filter(packet => packet.checkpoints[name]?.available).length]),
        ),
      },
      provenance: { sources: provenance.sources },
    },
    errors: symbolPackets.length === 0 ? [{ code: 'no_session_data', message: `No session packets could be built for ${input.session_date}` }] : errors,
    warnings,
    partialResults: warnings.length > 0 || symbolPackets.length < symbols.length,
    now,
    provenance,
  });
}

export async function runHeadlineResponseTest(args, { _deps } = {}) {
  const input = headlineResponseInputSchema.parse(args);
  const deps = resolveDeps(_deps);
  scheduleStaleScreenshotCleanup(deps);
  const now = deps.now();
  const warnings = [];
  const errors = [];
  const provenance = {
    sources: ['tradingview-mcp'],
    underlying_tools: [],
    cache_hits: [],
    symbols: input.asset_basket,
  };

  const observed = [];
  for (const symbol of input.asset_basket) {
    try {
      observed.push(await getHeadlineResponse(symbol, input, deps, provenance));
    } catch (err) {
      warnings.push({ code: 'headline_asset_unavailable', symbol, message: err.message });
    }
  }

  const usable = observed.filter(item => typeof item.immediate_return_pct === 'number');
  const expected = reactionTemplate(input.expected_response_template);
  const winnerHits = usable.filter(item => expected.winners.includes(item.symbol) && item.immediate_return_pct > 0).length;
  const loserHits = usable.filter(item => expected.losers.includes(item.symbol) && item.immediate_return_pct < 0).length;
  const score = winnerHits + loserHits;
  const reactionQuality = usable.length === 0
    ? 'inconclusive'
    : score >= Math.ceil(usable.length / 2)
      ? score === usable.length ? 'full_confirmation' : 'partial_confirmation'
      : 'contradiction';

  return envelope({
    packetType: 'run_headline_response_test',
    data: {
      headline: input.headline,
      timestamp: input.timestamp,
      expected_if_true: expected,
      observed_response: {
        immediate: observed.map(item => ({ symbol: item.symbol, return_pct: item.immediate_return_pct, status: item.status })),
        follow_through: observed.map(item => ({ symbol: item.symbol, return_pct: item.follow_through_return_pct, status: item.status })),
        reversal_or_confirmation: reactionQuality,
      },
      reaction_quality: reactionQuality,
      what_that_implies: reactionQuality === 'full_confirmation'
        ? `${input.topic} matched the expected market response`
        : reactionQuality === 'partial_confirmation'
          ? `${input.topic} had only partial market confirmation`
          : reactionQuality === 'contradiction'
            ? `${input.topic} conflicted with observed price action`
            : 'Response window lacked usable data',
      contradictions: observed
        .filter(item => typeof item.immediate_return_pct === 'number')
        .filter(item => (expected.winners.includes(item.symbol) && item.immediate_return_pct < 0) || (expected.losers.includes(item.symbol) && item.immediate_return_pct > 0))
        .map(item => `${item.symbol} moved against the template`),
      provenance: { sources: provenance.sources },
    },
    errors,
    warnings,
    partialResults: reactionQuality === 'inconclusive' || warnings.length > 0,
    now,
    provenance,
  });
}

export async function buildCrossAssetRegimePacket(args, { _deps } = {}) {
  const input = crossAssetInputSchema.parse(args);
  const deps = resolveDeps(_deps);
  scheduleStaleScreenshotCleanup(deps);
  const now = deps.now();
  const warnings = [];
  const provenance = {
    sources: ['tradingview-mcp'],
    underlying_tools: [],
    cache_hits: [],
    symbols: Object.values(input.assets).flat(),
  };

  const performance = [];
  for (const [group, symbols] of Object.entries(input.assets)) {
    for (const symbol of symbols) {
      try {
        performance.push(await getSymbolSnapshot(symbol, group, deps, provenance));
      } catch (err) {
        warnings.push({ code: 'cross_asset_gap', symbol, group, message: err.message });
      }
    }
  }

  const riskOn = performance.filter(item => ['equities', 'energy', 'crypto'].includes(item.group))
    .reduce((sum, item) => sum + item.return_pct, 0);
  const defensive = performance.filter(item => ['rates', 'vol', 'fx', 'gold'].includes(item.group))
    .reduce((sum, item) => sum + item.return_pct, 0);
  const leaders = classifyLeaders(performance, 5, 'desc');
  const laggards = classifyLeaders(performance, 5, 'asc');

  return envelope({
    packetType: 'build_cross_asset_regime_packet',
    data: {
      window: { from: input.date_from, to: input.date_to },
      relative_performance: performance.sort((a, b) => b.return_pct - a.return_pct),
      risk_on_vs_defensive_balance: riskOn > defensive ? 'risk_on' : defensive > riskOn ? 'defensive' : 'mixed',
      breadth_and_leadership: leaders.length > 0
        ? `Leaders: ${leaders.map(item => item.symbol).join(', ')}. Laggards: ${laggards.map(item => item.symbol).join(', ')}`
        : 'Breadth unavailable',
      cross_asset_tensions: performance
        .filter(item => (['equities', 'crypto'].includes(item.group) && defensive > 0) || (['gold', 'rates', 'vol'].includes(item.group) && riskOn > 0))
        .slice(0, 5)
        .map(item => `${item.symbol} moved with ${item.group} while the opposite regime also stayed firm`),
      regime_candidates: [
        riskOn > defensive ? 'risk_on' : 'defensive',
        Math.abs(riskOn - defensive) < 1 ? 'mixed_transition' : 'single_dominant_regime',
      ],
      best_fit_regime_summary: riskOn > defensive
        ? 'Risk assets outperformed defensive assets over the window'
        : defensive > riskOn
          ? 'Defensive assets dominated the window'
          : 'Cross-asset behavior was mixed',
      provenance: { sources: provenance.sources },
    },
    errors: [],
    warnings,
    partialResults: warnings.length > 0,
    now,
    provenance,
  });
}

export async function buildVehicleWatchlistPacket(args, { _deps } = {}) {
  const input = vehicleWatchlistInputSchema.parse(args);
  const deps = resolveDeps(_deps);
  scheduleStaleScreenshotCleanup(deps);
  const now = deps.now();
  const provenance = {
    sources: ['heuristic_mapping'],
    underlying_tools: [],
    cache_hits: [],
  };

  const candidates = buildVehicleCandidates(
    input.topic,
    input.regime_view,
    input.vehicle_classes,
    input.include_defensive,
    input.include_directional,
  );

  return envelope({
    packetType: 'build_vehicle_watchlist_packet',
    data: {
      vehicle_watchlist: candidates.map(candidate => ({
        vehicle: candidate.vehicle,
        class: candidate.class,
        direction: candidate.direction,
        why_it_fits: `${candidate.vehicle} matches the topic/regime tags: ${candidate.tags.join(', ')}`,
        what_confirms_it: [`Leadership consistent with ${candidate.class} peers`, `Price action aligns with ${input.regime_view}`],
        what_invalidates_it: ['Leadership fades versus peers', 'Cross-asset behavior contradicts the thesis'],
        confidence: candidate.class === 'hedge' ? 'medium' : 'low',
        status: candidate.class === 'hedge' ? 'observed_or_inferred' : 'provisional',
      })),
      best_expressions: candidates.slice(0, 3).map(candidate => candidate.vehicle),
      hedges: candidates.filter(candidate => candidate.class === 'hedge').map(candidate => candidate.vehicle),
      relative_value_candidates: candidates
        .filter(candidate => candidate.class === 'sector' || candidate.class === 'index')
        .slice(0, 2)
        .map(candidate => `${candidate.vehicle} vs hedge basket`),
      provenance: { sources: provenance.sources },
    },
    errors: [],
    warnings: candidates.length === 0 ? [{ code: 'no_candidates', message: 'Topic/regime mapping produced no candidates' }] : [],
    partialResults: candidates.length === 0,
    now,
    provenance,
  });
}

export async function buildNarrativeValidationPacket(args, { _deps } = {}) {
  const input = narrativeValidationInputSchema.parse(args);
  const deps = resolveDeps(_deps);
  scheduleStaleScreenshotCleanup(deps);
  const now = deps.now();
  const provenance = {
    sources: ['tradingview-mcp', 'heuristic_mapping'],
    underlying_tools: [],
    cache_hits: [],
    symbols: input.symbols,
  };
  const warnings = [];
  const supporting = [];
  const contradicting = [];
  const missing = [];

  for (const symbol of input.symbols) {
    try {
      const snapshot = await getSymbolSnapshot(symbol, 'validation', deps, provenance);
      if (snapshot.return_pct > 0) supporting.push(`${symbol} closed stronger over the sampled window`);
      else if (snapshot.return_pct < 0) contradicting.push(`${symbol} closed weaker over the sampled window`);
      else missing.push(`${symbol} was flat and needs a finer-grained test`);
    } catch (err) {
      warnings.push({ code: 'validation_symbol_gap', symbol, message: err.message });
      missing.push(`${symbol} could not be evaluated`);
    }
  }

  for (const claim of input.claims) {
    const lowered = claim.toLowerCase();
    if (lowered.includes('headline') && !deps.marketData.getHeadlineWindowResponse) {
      missing.push(`Need headline-response data to test claim: ${claim}`);
    }
    if (lowered.includes('defensive') && !input.symbols.some(symbol => /TLT|GLD|VIX|UUP/.test(symbol))) {
      missing.push(`Need defensive symbols to test claim: ${claim}`);
    }
  }

  return envelope({
    packetType: 'build_narrative_validation_packet',
    data: {
      narrative_title: input.narrative_title,
      supporting_evidence: supporting,
      contradicting_evidence: contradicting,
      missing_but_needed: missing,
      vehicle_implications: input.symbols.slice(0, 4).map(symbol => `${symbol} remains relevant if the narrative holds`),
      best_tests_next: [
        'Run build_market_session_packet for the focal session',
        'Run run_headline_response_test on the key catalyst timestamp',
        'Compare candidate vehicles against defensive hedges',
      ],
      provenance: { sources: provenance.sources },
    },
    errors: [],
    warnings,
    partialResults: missing.length > 0 || warnings.length > 0,
    now,
    provenance,
  });
}

export const schemas = {
  wrapperEnvelopeSchema,
  chartContextInputSchema,
  marketSessionInputSchema,
  headlineResponseInputSchema,
  crossAssetInputSchema,
  vehicleWatchlistInputSchema,
  narrativeValidationInputSchema,
};
