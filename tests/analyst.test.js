import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChartContextPacket,
  buildMarketSessionPacket,
  runHeadlineResponseTest,
  buildCrossAssetRegimePacket,
  buildVehicleWatchlistPacket,
  buildNarrativeValidationPacket,
  cleanupStaleScreenshots,
  resetAnalystCache,
  schemas,
} from '../src/core/analyst.js';

function makeDeps() {
  const calls = {
    setSymbol: 0,
    setTimeframe: 0,
    getOhlcv: 0,
    getStudyValues: 0,
    getPineLines: 0,
    getPineLabels: 0,
    getPineTables: 0,
    getPineBoxes: 0,
    captureScreenshot: 0,
    getHeadlineWindowResponse: 0,
    getSymbolSnapshot: 0,
    symbolSearch: 0,
  };

  const _cache = new Map();
  const now = () => new Date('2026-04-06T08:30:00.000Z');
  const currentSymbol = { value: 'SPY' };
  const currentTimeframe = { value: '5' };
  const sessionBarsBySymbol = {
    SPY: buildSessionBars({ open: 100, checkpoints: { open_30m: 101, midday: 102, close: 103 } }),
    QQQ: buildSessionBars({ open: 200, checkpoints: { open_30m: 203, midday: 205, close: 206 } }),
    IWM: buildSessionBars({ open: 50, checkpoints: { open_30m: 49.8, midday: 49, close: 48.5 } }),
    XLK: buildSessionBars({ open: 70, checkpoints: { open_30m: 71.2, midday: 72, close: 72.4 } }),
    XLF: buildSessionBars({ open: 40, checkpoints: { open_30m: 39.8, midday: 39.1, close: 38.9 } }),
    XLE: buildSessionBars({ open: 80, checkpoints: { open_30m: 80.4, midday: 81, close: 81.2 } }),
    TLT: buildSessionBars({ open: 90, checkpoints: { open_30m: 90.4, midday: 90.5, close: 90.6 } }),
    GLD: buildSessionBars({ open: 60, checkpoints: { open_30m: 60.1, midday: 60.2, close: 60.3 } }),
    VIX: buildSessionBars({
      premarket: [13.1, 13.2],
      open: 13,
      checkpoints: { open_30m: 12.7, midday: 12.4, close: 12.1 },
      premarketStart: 1775116800,
    }),
    BTCUSD: buildSessionBars({
      premarket: [30000, 30100],
      open: 30200,
      checkpoints: { open_30m: 30300, midday: 30500, close: 30750 },
      premarketStart: 1775116800,
    }),
  };

  return {
    calls,
    deps: {
      _cache,
      now,
      chart: {
        async setSymbol({ symbol }) {
          calls.setSymbol += 1;
          currentSymbol.value = symbol;
          return { success: true, symbol };
        },
        async setTimeframe({ timeframe }) {
          calls.setTimeframe += 1;
          currentTimeframe.value = String(timeframe);
          return { success: true, timeframe };
        },
        async scrollToDate() {
          return { success: true };
        },
        async symbolSearch({ query }) {
          calls.symbolSearch += 1;
          const table = {
            SPY: [{ symbol: 'SPY', exchange: 'BATS', type: 'stock', full_name: 'BATS:SPY' }],
            QQQ: [{ symbol: 'QQQ', exchange: 'BATS', type: 'stock', full_name: 'BATS:QQQ' }],
            XLK: [{ symbol: 'XLK', exchange: 'AMEX', type: 'stock', full_name: 'AMEX:XLK' }],
          };
          return { success: true, results: table[query] || [] };
        },
        async getState() {
          return {
            success: true,
            symbol: currentSymbol.value,
            resolution: currentTimeframe.value,
            studies: [{ id: 'rsi-1', name: 'Relative Strength Index' }],
          };
        },
        async manageIndicator() {
          return { success: true };
        },
      },
      data: {
        async getOhlcv({ summary } = {}) {
          calls.getOhlcv += 1;
          if (!summary && sessionBarsBySymbol[currentSymbol.value]) {
            return {
              success: true,
              bar_count: sessionBarsBySymbol[currentSymbol.value].length,
              total_available: sessionBarsBySymbol[currentSymbol.value].length,
              source: 'mock_session_bars',
              bars: sessionBarsBySymbol[currentSymbol.value],
            };
          }
          return {
            success: true,
            open: 100,
            close: 104,
            high: 106,
            low: 99,
            range: 7,
            change: 4,
            change_pct: '4%',
            avg_volume: 1200,
          };
        },
        async getStudyValues() {
          calls.getStudyValues += 1;
          return {
            success: true,
            studies: [
              { name: 'Relative Strength Index', values: { RSI: '62.4' } },
              { name: 'MACD', values: { MACD: '1.1', Signal: '0.9' } },
            ],
          };
        },
        async getPineLines() {
          calls.getPineLines += 1;
          return { success: true, studies: [{ name: 'Levels', horizontal_levels: [103, 107] }] };
        },
        async getPineLabels() {
          calls.getPineLabels += 1;
          return { success: true, studies: [{ labels: [{ text: 'PDH', price: 107 }] }] };
        },
        async getPineTables() {
          calls.getPineTables += 1;
          return { success: true, studies: [{ tables: [{ rows: ['Bias | Up'] }] }] };
        },
        async getPineBoxes() {
          calls.getPineBoxes += 1;
          return { success: true, studies: [] };
        },
        async getQuote({ symbol }) {
          return {
            success: true,
            requested_symbol: symbol,
            resolved_symbol: currentSymbol.value,
            symbol: currentSymbol.value,
            time: 1775460000,
            open: 100,
            high: 101,
            low: 99,
            close: 100.5,
            last: 100.5,
            volume: 1000,
          };
        },
      },
      capture: {
        async captureScreenshot() {
          calls.captureScreenshot += 1;
          return { success: true, file_path: '/tmp/test-shot.png' };
        },
      },
      evaluate: async () => ({ found: false, overlays: [] }),
      marketData: {
        async getSymbolSnapshot({ symbol, group }) {
          calls.getSymbolSnapshot += 1;
          const returns = {
            SPY: 1.2,
            QQQ: 1.8,
            IWM: -0.4,
            XLK: 2.0,
            XLF: -0.7,
            XLE: 0.9,
            TLT: 0.4,
            GLD: 0.3,
            VIX: -2.1,
            BTCUSD: 2.4,
          };
          return {
            symbol,
            group,
            last: 100,
            previous_close: 98,
            return_pct: returns[symbol] ?? 0,
            source: 'mock_provider',
          };
        },
        async getHeadlineWindowResponse({ symbol }) {
          calls.getHeadlineWindowResponse += 1;
          const immediate = {
            SPY: 0.8,
            QQQ: 1.1,
            TLT: -0.5,
            GLD: -0.2,
            VIX: -3.0,
            'CL1!': 0.4,
          };
          const follow = {
            SPY: 1.2,
            QQQ: 1.6,
            TLT: -0.8,
            GLD: -0.3,
            VIX: -4.4,
            'CL1!': 0.6,
          };
          return {
            symbol,
            immediate_return_pct: immediate[symbol] ?? null,
            follow_through_return_pct: follow[symbol] ?? null,
            status: immediate[symbol] == null ? 'missing' : 'ok',
          };
        },
      },
    },
  };
}

function buildSessionBars({ open, checkpoints, premarket = [], premarketStart = 1775124000 }) {
  const bars = [];
  for (let i = 0; i < premarket.length; i += 1) {
    const price = premarket[i];
    bars.push({
      time: premarketStart + i * 300,
      open: price,
      high: price + 0.1,
      low: price - 0.1,
      close: price,
      volume: 1000,
    });
  }

  const regularStart = 1775136600;
  const regularEnd = 1775159700;
  const closeTargets = {
    [regularStart]: open,
    1775138400: checkpoints.open_30m,
    1775145600: checkpoints.midday,
    [regularEnd]: checkpoints.close,
  };
  let prevClose = open;
  for (let ts = regularStart; ts <= regularEnd; ts += 300) {
    const ratio = (ts - regularStart) / (regularEnd - regularStart || 1);
    const target = ts <= 1775138400
      ? open + ((checkpoints.open_30m - open) * ((ts - regularStart) / (1775138400 - regularStart || 1)))
      : ts <= 1775145600
        ? checkpoints.open_30m + ((checkpoints.midday - checkpoints.open_30m) * ((ts - 1775138400) / (1775145600 - 1775138400 || 1)))
        : checkpoints.midday + ((checkpoints.close - checkpoints.midday) * ((ts - 1775145600) / (regularEnd - 1775145600 || 1)));
    const close = closeTargets[ts] ?? Number(target.toFixed(3));
    bars.push({
      time: ts,
      open: prevClose,
      high: Math.max(prevClose, close) + 0.15,
      low: Math.min(prevClose, close) - 0.15,
      close,
      volume: 5000 + Math.round(ratio * 1000),
    });
    prevClose = close;
  }
  return bars;
}

describe('analyst wrappers', () => {
  it('buildChartContextPacket returns stable schema and reuses cached work', async () => {
    const { deps, calls } = makeDeps();
    resetAnalystCache({ _deps: deps });

    const first = await buildChartContextPacket({
      symbol: 'XLE',
      timeframes: ['15', '60'],
      study_preset: 'macro_trend',
      include_screenshot: true,
      include_pine_context: true,
      lookback_bars: 100,
    }, { _deps: deps });

    const second = await buildChartContextPacket({
      symbol: 'XLE',
      timeframes: ['15', '60'],
      study_preset: 'macro_trend',
      include_screenshot: false,
      include_pine_context: true,
      lookback_bars: 100,
    }, { _deps: deps });

    schemas.wrapperEnvelopeSchema.parse(first);
    assert.equal(first.success, true);
    assert.equal(first.packet_type, 'build_chart_context_packet');
    assert.equal(Object.keys(first.data.timeframes).length, 2);
    assert.equal(first.data.screenshot_paths.length, 2);
    assert.ok(second.provenance.cache_hits.length >= 2);
    assert.equal(calls.getOhlcv, 2);
    assert.equal(calls.getStudyValues, 2);
  });

  it('buildChartContextPacket marks partial results when pine context fails', async () => {
    const { deps } = makeDeps();
    deps.data.getPineLines = async () => { throw new Error('Pine hidden'); };

    const result = await buildChartContextPacket({
      symbol: 'XLE',
      timeframes: ['D'],
      study_preset: 'levels_only',
      include_pine_context: true,
    }, { _deps: deps });

    assert.equal(result.success, true);
    assert.equal(result.partial_results, true);
    assert.ok(result.warnings.some(w => w.code === 'pine_lines_unavailable'));
  });

  it('buildChartContextPacket accepts study_preset none without applying studies', async () => {
    const { deps } = makeDeps();

    const result = await buildChartContextPacket({
      symbol: 'XLE',
      timeframes: ['5'],
      study_preset: 'none',
      include_screenshot: false,
      include_pine_context: false,
    }, { _deps: deps });

    assert.equal(result.success, true);
    assert.equal(result.data.provenance.study_preset, 'none');
  });

  it('buildMarketSessionPacket returns checkpoint evidence, rankings, and data quality', async () => {
    const { deps } = makeDeps();
    const result = await buildMarketSessionPacket({
      session_date: '2026-04-02',
      region: 'US',
      checkpoints: ['premarket', 'open_30m', 'midday', 'close'],
      benchmarks: ['SPY', 'QQQ', 'IWM'],
      sectors: ['XLK', 'XLF', 'XLE'],
      hedges: ['TLT', 'GLD', 'VIX'],
      optional_symbols: ['BTCUSD'],
    }, { _deps: deps });

    assert.equal(result.success, true);
    assert.equal(result.data.timezone, 'America/New_York');
    assert.equal(result.data.bar_timeframe, '5');
    assert.ok(result.data.session_definition.checkpoints.open_30m.includes('-04:00'));
    assert.ok(result.data.checkpoint_matrix.length >= 7);
    assert.ok(result.data.checkpoint_rankings.close.length >= 3);
    assert.ok(result.data.relative_strength_spreads.some(item => item.name === 'QQQ_minus_SPY'));
    assert.ok(result.data.opening_context.some(item => item.symbol === 'SPY'));
    assert.ok(result.data.session_structure.some(item => item.symbol === 'SPY'));
    assert.ok(result.data.range_stats.some(item => item.symbol === 'SPY'));
    assert.ok(result.data.data_quality.some(item => item.requested_symbol === 'SPY'));
    assert.equal(result.data.coverage_summary.requested_symbol_count, 10);
  });

  it('buildMarketSessionPacket falls back to the nearest available prior session when the requested date has no bars', async () => {
    const { deps } = makeDeps();
    const result = await buildMarketSessionPacket({
      session_date: '2026-04-06',
      region: 'US',
      checkpoints: ['premarket', 'open_30m', 'midday', 'close'],
      benchmarks: ['SPY', 'QQQ'],
      sectors: ['XLK'],
      hedges: ['TLT'],
      optional_symbols: [],
    }, { _deps: deps });

    assert.equal(result.success, true);
    assert.equal(result.partial_results, true);
    assert.equal(result.data.requested_session_date, '2026-04-06');
    assert.equal(result.data.resolved_session_date, '2026-04-02');
    assert.ok(result.warnings.some(w => w.code === 'session_packet_date_fallback'));
    assert.ok(result.data.data_quality.every(item => item.session_date_fallback_used === true));
  });

  it('buildMarketSessionPacket fails clearly for unsupported regions', async () => {
    const { deps } = makeDeps();
    const result = await buildMarketSessionPacket({
      session_date: '2026-04-02',
      region: 'EU',
      checkpoints: ['open_30m', 'midday', 'close'],
      benchmarks: ['SPY'],
      sectors: [],
      hedges: [],
    }, { _deps: deps });

    assert.equal(result.success, false);
    assert.equal(result.errors[0].code, 'unsupported_region');
  });

  it('runHeadlineResponseTest returns inconclusive when provider data is missing', async () => {
    const { deps } = makeDeps();
    deps.marketData.getHeadlineWindowResponse = undefined;

    const result = await runHeadlineResponseTest({
      headline: 'Iran signaled willingness to de-escalate',
      timestamp: '2026-04-02T13:14:00Z',
      topic: 'risk-on relief',
      asset_basket: ['SPY', 'QQQ', 'TLT'],
      expected_response_template: 'risk_on',
    }, { _deps: deps });

    assert.equal(result.success, true);
    assert.equal(result.data.reaction_quality, 'inconclusive');
    assert.equal(result.partial_results, true);
  });

  it('buildCrossAssetRegimePacket tolerates one unavailable asset class', async () => {
    const { deps } = makeDeps();
    deps.marketData.getSymbolSnapshot = async ({ symbol, group }) => {
      if (group === 'fx') throw new Error('FX unavailable');
      return {
        symbol,
        group,
        last: 100,
        previous_close: 99,
        return_pct: group === 'equities' ? 1 : -0.3,
        source: 'mock_provider',
      };
    };

    const result = await buildCrossAssetRegimePacket({
      date_from: '2026-03-28',
      date_to: '2026-04-06',
      assets: {
        equities: ['SPY', 'QQQ'],
        rates: ['TLT'],
        vol: ['VIX'],
        fx: ['UUP'],
        gold: ['GLD'],
        energy: ['USO'],
        crypto: ['BTCUSD'],
      },
    }, { _deps: deps });

    assert.equal(result.success, true);
    assert.equal(result.partial_results, true);
    assert.ok(result.warnings.some(w => w.code === 'cross_asset_gap'));
  });

  it('buildVehicleWatchlistPacket labels directional candidates as provisional when confirmation is thin', async () => {
    const result = await buildVehicleWatchlistPacket({
      topic: 'US relief rally after geopolitical scare',
      regime_view: 'short-term relief, medium-term fragile',
      vehicle_classes: ['index', 'sector', 'hedge', 'options'],
      include_defensive: true,
      include_directional: true,
    });

    assert.equal(result.success, true);
    assert.ok(result.data.vehicle_watchlist.some(item => item.status === 'provisional'));
    assert.ok(result.data.hedges.length > 0);
  });

  it('buildNarrativeValidationPacket moves unsupported claims into missing_but_needed', async () => {
    const { deps } = makeDeps();
    deps.marketData.getHeadlineWindowResponse = undefined;

    const result = await buildNarrativeValidationPacket({
      narrative_title: 'Relief rally is real but leadership is too defensive',
      claims: [
        'headline improved sentiment',
        'broad risk appetite did not fully confirm',
        'defensive hedges stayed too firm',
      ],
      symbols: ['SPY', 'QQQ', 'TLT', 'GLD', 'VIX', 'XLE'],
      date_window: { from: '2026-04-02', to: '2026-04-06' },
    }, { _deps: deps });

    assert.equal(result.success, true);
    assert.ok(result.data.missing_but_needed.some(item => item.includes('headline-response')));
  });

  it('cleanupStaleScreenshots removes screenshot files older than one day and high-level wrappers trigger it', async () => {
    const removed = [];
    const fakeFs = {
      async readdir() {
        return [
          { name: 'old.png', isFile: () => true },
          { name: 'fresh.png', isFile: () => true },
        ];
      },
      async stat(filePath) {
        if (filePath.endsWith('old.png')) {
          return {
            birthtimeMs: Date.parse('2026-04-04T07:00:00.000Z'),
            ctimeMs: Date.parse('2026-04-04T07:00:00.000Z'),
            mtimeMs: Date.parse('2026-04-04T07:00:00.000Z'),
          };
        }
        return {
          birthtimeMs: Date.parse('2026-04-06T07:00:00.000Z'),
          ctimeMs: Date.parse('2026-04-06T07:00:00.000Z'),
          mtimeMs: Date.parse('2026-04-06T07:00:00.000Z'),
        };
      },
      async rm(filePath) {
        removed.push(filePath);
      },
    };

    const result = await cleanupStaleScreenshots({}, {
      _deps: {
        now: () => new Date('2026-04-06T08:30:00.000Z'),
        fileSystem: fakeFs,
        screenshotDir: '/tmp/shots',
      },
    });

    assert.equal(result.success, true);
    assert.deepEqual(result.data.removed_files, ['/tmp/shots/old.png']);

    await buildVehicleWatchlistPacket({
      topic: 'US relief rally after geopolitical scare',
      regime_view: 'short-term relief, medium-term fragile',
      vehicle_classes: ['index'],
      include_defensive: false,
      include_directional: true,
    }, {
      _deps: {
        now: () => new Date('2026-04-06T08:30:00.000Z'),
        fileSystem: fakeFs,
        screenshotDir: '/tmp/shots',
      },
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.ok(removed.includes('/tmp/shots/old.png'));
  });
});
