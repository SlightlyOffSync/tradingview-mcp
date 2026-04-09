import * as chart from './chart.js';

const KNOWN_SYMBOL_MAPPINGS = {
  SPY: ['BATS:SPY', 'AMEX:SPY', 'ARCA:SPY'],
  QQQ: ['BATS:QQQ', 'NASDAQ:QQQ'],
  IWM: ['BATS:IWM', 'AMEX:IWM', 'ARCA:IWM'],
  XLF: ['AMEX:XLF', 'BATS:XLF', 'ARCA:XLF'],
  XLK: ['AMEX:XLK', 'BATS:XLK', 'ARCA:XLK'],
  XLE: ['AMEX:XLE', 'BATS:XLE', 'ARCA:XLE'],
  XLI: ['AMEX:XLI', 'BATS:XLI', 'ARCA:XLI'],
  XLV: ['AMEX:XLV', 'BATS:XLV', 'ARCA:XLV'],
  TLT: ['NASDAQ:TLT', 'BATS:TLT'],
  GLD: ['AMEX:GLD', 'BATS:GLD', 'ARCA:GLD'],
  VIX: ['TVC:VIX', 'CBOE:VIX'],
  DXY: ['INDEX:DXY', 'TVC:DXY'],
  BTCUSD: ['BITSTAMP:BTCUSD', 'COINBASE:BTCUSD', 'TVC:BTCUSD'],
  'ES1!': ['CME_MINI:ES1!', 'CME:ES1!'],
  'NQ1!': ['CME_MINI:NQ1!', 'CME:NQ1!'],
  'RTY1!': ['CME_MINI:RTY1!', 'CME:RTY1!'],
  'CL1!': ['NYMEX:CL1!', 'TVC:USOIL'],
};

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function bareSymbol(value) {
  return upper(value).split(':').pop();
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function scoreCandidate(requested, candidate, preferred = []) {
  const requestedUpper = upper(requested);
  const candidateUpper = upper(candidate.full_name || candidate.symbol);
  const candidateBare = bareSymbol(candidateUpper);
  const requestedBare = bareSymbol(requestedUpper);

  let score = 0;
  if (candidateUpper === requestedUpper) score += 100;
  if (candidateBare === requestedBare) score += 60;
  if (preferred.includes(candidateUpper)) score += 30;
  if (candidate.exchange && preferred.some(item => item.startsWith(`${upper(candidate.exchange)}:`))) score += 10;
  if (candidate.type === 'index' && ['VIX', 'DXY'].includes(requestedBare)) score += 5;
  if (candidate.type === 'futures' && requestedBare.endsWith('1!')) score += 5;
  return score;
}

function summarizeConfidence(score) {
  if (score >= 100) return 'high';
  if (score >= 70) return 'medium';
  if (score > 0) return 'low';
  return 'none';
}

export function symbolsMatch(left, right) {
  return upper(left) === upper(right) || bareSymbol(left) === bareSymbol(right);
}

export async function normalizeSymbol({ symbol }, { _deps } = {}) {
  const requestedSymbol = String(symbol || '').trim();
  if (!requestedSymbol) {
    return {
      success: false,
      requested_symbol: requestedSymbol,
      resolved_symbol: null,
      alternates: [],
      confidence: 'none',
      resolution_method: 'empty_input',
      error: 'Symbol is required',
    };
  }

  const requestedUpper = upper(requestedSymbol);
  const requestedBare = bareSymbol(requestedUpper);
  const preferred = unique([
    ...(KNOWN_SYMBOL_MAPPINGS[requestedUpper] || []),
    requestedUpper.includes(':') ? requestedUpper : null,
  ]);

  if (requestedUpper.includes(':')) {
    return {
      success: true,
      requested_symbol: requestedSymbol,
      resolved_symbol: requestedBare,
      alternates: [],
      confidence: 'high',
      resolution_method: 'input_prefixed_stripped',
    };
  }

  if (KNOWN_SYMBOL_MAPPINGS[requestedUpper]?.length) {
    return {
      success: true,
      requested_symbol: requestedSymbol,
      resolved_symbol: requestedUpper,
      alternates: unique(KNOWN_SYMBOL_MAPPINGS[requestedUpper].map(item => bareSymbol(item))).filter(item => item !== requestedUpper),
      confidence: 'high',
      resolution_method: 'known_mapping_bare',
    };
  }

  const searchImpl = _deps?.chart?.symbolSearch || chart.symbolSearch;
  let results = [];
  let searchError = null;
  if (preferred.length === 0) {
    try {
      const response = await searchImpl({ query: bareSymbol(requestedUpper) });
      results = response?.results || [];
    } catch (err) {
      searchError = err;
    }
  }

  const candidates = unique([
    requestedBare,
    ...preferred,
    ...results.map(item => upper(item.full_name || item.symbol)),
  ]).map(fullName => {
    const searchHit = results.find(item => upper(item.full_name || item.symbol) === fullName);
    if (searchHit) return searchHit;
    const [exchange, symbolPart] = fullName.includes(':') ? fullName.split(':') : ['', fullName];
    return {
      symbol: symbolPart,
      exchange,
      type: '',
      description: '',
      full_name: fullName,
    };
  });

  const ranked = candidates
    .map(candidate => ({ ...candidate, _score: scoreCandidate(requestedSymbol, candidate, preferred) }))
    .sort((a, b) => b._score - a._score);

  const best = ranked[0];
  if (!best || best._score <= 0) {
    return {
      success: false,
      requested_symbol: requestedSymbol,
      resolved_symbol: null,
      alternates: ranked.slice(0, 5).map(item => item.full_name || item.symbol),
      confidence: 'none',
      resolution_method: searchError ? 'search_failed' : 'unresolved',
      error: searchError?.message || `Could not normalize symbol ${requestedSymbol}`,
    };
  }

  const bestFullName = best.full_name || best.symbol;
  const resolutionMethod = preferred.includes(bestFullName)
    ? 'known_mapping'
    : upper(bestFullName) === requestedUpper
      ? 'search_exact'
      : 'search_fuzzy';

  return {
    success: true,
    requested_symbol: requestedSymbol,
    resolved_symbol: bestFullName,
    alternates: ranked
      .slice(1, 6)
      .map(item => item.full_name || item.symbol)
      .filter(item => upper(item) !== upper(bestFullName)),
    confidence: summarizeConfidence(best._score),
    resolution_method: resolutionMethod,
    search_results_considered: ranked.slice(0, 5).map(item => ({
      symbol: item.symbol,
      exchange: item.exchange,
      type: item.type,
      full_name: item.full_name || item.symbol,
      score: item._score,
    })),
  };
}
