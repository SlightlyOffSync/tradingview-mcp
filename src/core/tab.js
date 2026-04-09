/**
 * Core tab management logic.
 * Controls TradingView Desktop tabs via CDP target activation and page-driven tab creation.
 */
import CDP from 'chrome-remote-interface';
import { evaluate } from '../connection.js';
import { symbolSearch } from './chart.js';

const CDP_HOST = 'localhost';
const CDP_PORT = 9222;

function classifyTab(url = '') {
  if (/\/chart\//i.test(url)) return 'chart';
  if (/\/news-flow\//i.test(url)) return 'news-flow';
  if (/\/screener\/?/i.test(url)) return 'screener';
  if (/tradingview\.com/i.test(url)) return 'tradingview-page';
  return 'other';
}

function isTradingViewPageTarget(target) {
  return target?.type === 'page' && /^https:\/\/www\.tradingview\.com\//i.test(target.url || '');
}

async function cdpJson(path, options) {
  const response = await fetch(`http://${CDP_HOST}:${CDP_PORT}${path}`, options);
  return response;
}

async function withTargetClient(targetId, fn) {
  const client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: targetId });
  try {
    await client.Runtime.enable();
    await client.DOM.enable();
    return await fn(client);
  } finally {
    try { await client.close(); } catch {}
  }
}

async function listPageTargets() {
  const resp = await cdpJson('/json/list');
  const targets = await resp.json();
  return targets.filter(isTradingViewPageTarget);
}

function normalizeTab(target, index) {
  return {
    index,
    id: target.id,
    title: target.title.replace(/^Live stock.*charts on /, '') || 'TradingView',
    url: target.url,
    kind: classifyTab(target.url),
    chart_id: target.url.match(/\/chart\/([^/?]+)/)?.[1] || null,
  };
}

function viewUrl(view) {
  const normalized = String(view || 'chart').trim().toLowerCase();
  const map = {
    chart: 'https://www.tradingview.com/chart/',
    'news-flow': 'https://www.tradingview.com/news-flow/',
    news: 'https://www.tradingview.com/news-flow/',
    screener: 'https://www.tradingview.com/screener/',
  };
  if (!map[normalized]) throw new Error(`Unsupported tab view "${view}". Use chart, news-flow, or screener.`);
  return map[normalized];
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function bareSymbol(value) {
  return upper(value).split(':').pop();
}

function isWatchlistNewsTab(tab) {
  return tab?.kind === 'news-flow' && /[?&]watchlist=/i.test(tab.url || '');
}

function isTickerNewsTab(tab, symbol) {
  const url = String(tab?.url || '');
  return tab?.kind === 'news-flow' && url.includes(`symbol=${encodeURIComponent(symbol)}`);
}

function scoreNewsSymbolCandidate(requested, candidate) {
  const requestedUpper = upper(requested);
  const requestedBare = bareSymbol(requestedUpper);
  const fullName = upper(candidate.full_name || candidate.symbol);
  const candidateBare = bareSymbol(fullName);
  let score = 0;
  if (fullName === requestedUpper) score += 100;
  if (candidateBare === requestedBare) score += 60;
  if (candidate.exchange) score += 10;
  if (candidate.type === 'fund') score += 5;
  if (candidate.type === 'index' && ['VIX', 'DXY'].includes(requestedBare)) score += 5;
  if (candidate.type === 'futures' && requestedBare.endsWith('1!')) score += 5;
  return score;
}

async function resolveNewsInstrumentSymbol(ticker) {
  const requested = String(ticker || '').trim();
  if (!requested) return null;
  if (requested.includes(':')) return requested;

  const response = await symbolSearch({ query: bareSymbol(requested) });
  const ranked = (response.results || [])
    .map(item => ({ ...item, _score: scoreNewsSymbolCandidate(requested, item) }))
    .sort((a, b) => b._score - a._score);

  const best = ranked[0];
  if (!best || best._score <= 0) {
    throw new Error(`Could not resolve news instrument ticker "${ticker}"`);
  }
  return best.full_name || best.symbol;
}

function buildNewsFlowUrl({ tickerSymbol } = {}) {
  if (tickerSymbol) {
    return `https://www.tradingview.com/news-flow/?symbol=${encodeURIComponent(tickerSymbol)}`;
  }
  return viewUrl('news-flow');
}

function findMatchingTab(tabs, match) {
  const needle = String(match).trim().toLowerCase();
  return tabs.find(tab =>
    tab.kind.toLowerCase() === needle
    || tab.title.toLowerCase().includes(needle)
    || tab.url.toLowerCase().includes(needle),
  );
}

function toMarkdownArticle(article) {
  if (!article) return null;
  const lines = [];
  if (article.title) lines.push(`# ${article.title}`);
  if (article.read_time) lines.push(`- Read time: ${article.read_time}`);
  if (article.author) lines.push(`- Author: ${article.author}`);
  if (article.related_symbols?.length) {
    lines.push(`- Symbols: ${article.related_symbols.map(item => item.symbol).join(', ')}`);
  }
  if (article.paragraphs?.length) {
    lines.push('');
    lines.push(...article.paragraphs);
  } else if (article.body_text) {
    lines.push('');
    lines.push(article.body_text);
  }
  return lines.join('\n');
}

async function waitForTradingViewTab(predicate, attempts = 20, delayMs = 300) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const state = await list();
    const found = state.tabs.find(predicate);
    if (found) return { state, found };
    await new Promise(r => setTimeout(r, delayMs));
  }
  return { state: await list(), found: null };
}

async function evaluateOnTarget(targetId, expression) {
  return withTargetClient(targetId, async (client) => {
    const result = await client.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      const message = result.exceptionDetails.exception?.description
        || result.exceptionDetails.text
        || 'Unknown evaluation error';
      throw new Error(`JS evaluation error: ${message}`);
    }
    return result.result?.value;
  });
}

async function extractNewsFlowPayload(targetId, { limit, includeContent = false } = {}) {
  const normalizedLimit = limit == null ? null : Math.max(1, Number(limit) || 1);
  const expression = `
    (function() {
      function clean(value) {
        return String(value || '').replace(/\\s+/g, ' ').trim();
      }
      function uniqueBy(items, keyFn) {
        var seen = new Set();
        return items.filter(function(item) {
          var key = keyFn(item);
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
      var anchors = Array.from(document.querySelectorAll('a[href*="/news/"]'));
      var headlineCards = uniqueBy(anchors.map(function(anchor) {
        var lines = clean(anchor.innerText).split(/\\n+/).map(clean).filter(Boolean);
        var titleNode = anchor.querySelector('[class*="title"]');
        var providerNode = anchor.querySelector('[class*="provider"], [class*="source"]');
        var dateNode = anchor.querySelector('relative-time')
          || anchor.querySelector('[class*="time"], [class*="date"], [data-field="time"]');
        var title = clean(titleNode ? titleNode.innerText : (lines.length > 1 ? lines.slice(1).join(' ') : lines[0] || ''));
        var provider = clean(providerNode ? providerNode.innerText : (lines.length > 1 ? lines[0] : ''));
        var rawText = clean(anchor.innerText);
        return {
          href: anchor.href || null,
          provider: provider || null,
          headline: title || null,
          date: clean(dateNode ? (dateNode.innerText || dateNode.getAttribute('title') || dateNode.getAttribute('event-time')) : '') || null,
          selected: String(anchor.className || '').includes('selected'),
          raw_text: rawText || null
        };
      }), function(item) { return item.href; }).filter(function(item) {
        return item.href && item.headline;
      });
      if (${normalizedLimit == null ? 'null' : normalizedLimit} != null) {
        headlineCards = headlineCards.slice(0, ${normalizedLimit == null ? '0' : normalizedLimit});
      }

      var payload = {
        page_title: document.title,
        page_url: location.href,
        headline_count: headlineCards.length,
        headlines: headlineCards,
      };

      if (${includeContent ? 'true' : 'false'}) {
        var pane = document.querySelector('[class*="rightPane"] [class*="storyContainer"]')
          || document.querySelector('[class*="rightPane"] article')
          || document.querySelector('[class*="rightPane"] [class*="body"]');
        if (pane) {
          var text = pane.innerText || '';
          var lines = text.split(/\\n+/).map(clean).filter(Boolean);
          var title = clean((pane.querySelector('h1, h2, [class*="title"]') || {}).innerText || lines[0] || '');
          var readTime = lines.find(function(line) { return /\\b\\d+\\s+min read\\b/i.test(line); }) || null;
          var author = lines.find(function(line) { return /^By\\s+/i.test(line); }) || null;
          var paragraphs = Array.from(pane.querySelectorAll('p'))
            .map(function(node) { return clean(node.innerText); })
            .filter(Boolean);
          var symbols = uniqueBy(Array.from(pane.querySelectorAll('a[href*="/symbols/"]')).map(function(a) {
            return {
              symbol: clean(a.innerText) || null,
              href: a.href || null,
            };
          }).filter(function(item) { return item.symbol; }), function(item) { return item.href || item.symbol; });
          payload.selected_article = {
            title: title || null,
            read_time: readTime,
            author: author,
            paragraphs: paragraphs,
            body_text: clean(paragraphs.join('\\n\\n') || text).slice(0, 12000) || null,
            related_symbols: symbols,
          };
        } else {
          payload.selected_article = null;
        }
      }

      return payload;
    })()
  `;
  return evaluateOnTarget(targetId, expression);
}

async function waitForNewsFlowReady(targetId, { expectedUrlFragment, requireHeadlines = false, attempts = 30, delayMs = 500 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const status = await evaluateOnTarget(targetId, `
        (function() {
          return {
            href: location.href,
            title: document.title,
            ready_state: document.readyState,
            headline_count: document.querySelectorAll('a[href*="/news/"]').length
          };
        })()
      `);
      const matchesUrl = !expectedUrlFragment || String(status.href || '').includes(expectedUrlFragment);
      const matchesHeadlines = !requireHeadlines || Number(status.headline_count || 0) > 0;
      if (status.ready_state === 'complete' && matchesUrl && matchesHeadlines) {
        return status;
      }
    } catch {}
    await new Promise(r => setTimeout(r, delayMs));
  }
  return null;
}

async function ensureNewsFlowTab({ openIfMissing = true } = {}) {
  let state = await list();
  let target = findMatchingTab(state.tabs, 'news-flow');

  if (!target && openIfMissing) {
    const created = await newTab({ view: 'news-flow' });
    if (!created.success || !created.opened) {
      throw new Error(created.error || 'Could not open a News Flow tab');
    }
    state = await list();
    target = state.tabs.find(tab => tab.id === created.opened.id) || created.opened;
  }

  if (!target) {
    throw new Error('No News Flow tab is open');
  }

  await switchTab({ index: target.index });
  const settled = await waitForTradingViewTab(tab => tab.id === target.id, 8, 250);
  return settled.found || target;
}

async function ensureNewsFlowContext({ openIfMissing = true, ticker } = {}) {
  const resolvedTicker = ticker ? await resolveNewsInstrumentSymbol(ticker) : null;
  let state = await list();
  let target = resolvedTicker
    ? state.tabs.find(tab => isTickerNewsTab(tab, resolvedTicker))
    : state.tabs.find(isWatchlistNewsTab) || state.tabs.find(tab => tab.kind === 'news-flow');

  if (!target && openIfMissing) {
    const created = await newTab({ url: buildNewsFlowUrl({ tickerSymbol: resolvedTicker }) });
    if (!created.success || !created.opened) {
      throw new Error(created.error || 'Could not open a News Flow tab');
    }
    state = await list();
    target = state.tabs.find(tab => tab.id === created.opened.id) || created.opened;
  }

  if (!target) {
    throw new Error('No News Flow tab is open');
  }

  if (resolvedTicker && !isTickerNewsTab(target, resolvedTicker)) {
    await switchTab({ index: target.index });
    await evaluateOnTarget(target.id, `location.href = ${JSON.stringify(buildNewsFlowUrl({ tickerSymbol: resolvedTicker }))}; true`);
  } else if (!resolvedTicker && !isWatchlistNewsTab(target) && /[?&]symbol=/i.test(target.url || '')) {
    const watchlistTab = state.tabs.find(isWatchlistNewsTab);
    if (watchlistTab) {
      target = watchlistTab;
    } else if (openIfMissing) {
      const created = await newTab({ url: buildNewsFlowUrl() });
      if (!created.success || !created.opened) {
        throw new Error(created.error || 'Could not open a watchlist News Flow tab');
      }
      target = created.opened;
    }
  }

  await switchTab({ index: target.index });
  const settled = await waitForTradingViewTab(tab => {
    if (tab.id !== target.id) return false;
    if (resolvedTicker) return isTickerNewsTab(tab, resolvedTicker);
    return tab.kind === 'news-flow';
  }, 20, 250);

  const finalTarget = settled.found || target;
  await waitForNewsFlowReady(finalTarget.id, {
    expectedUrlFragment: resolvedTicker
      ? `symbol=${encodeURIComponent(resolvedTicker)}`
      : null,
    requireHeadlines: true,
  });

  return {
    target: finalTarget,
    resolved_ticker: resolvedTicker,
    filter_mode: resolvedTicker ? 'instrument' : 'watchlist',
  };
}

async function readNewsHeadlines(targetId, { limit } = {}) {
  const payload = await extractNewsFlowPayload(targetId, { limit, includeContent: false });
  return {
    page_title: payload.page_title,
    page_url: payload.page_url,
    headline_count: payload.headline_count,
    headlines: (payload.headlines || []).map((item, index) => ({
      id: index + 1,
      headline: item.headline,
      date: item.date ?? null,
    })),
  };
}

async function clickNewsHeadline(targetId, id) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId < 1) {
    throw new Error(`Invalid news headline id "${id}"`);
  }
  const expression = `
    (function() {
      function clean(value) {
        return String(value || '').replace(/\\s+/g, ' ').trim();
      }
      function uniqueBy(items, keyFn) {
        var seen = new Set();
        return items.filter(function(item) {
          var key = keyFn(item);
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
      var anchors = uniqueBy(Array.from(document.querySelectorAll('a[href*="/news/"]')), function(anchor) {
        return anchor.href;
      });
      var anchor = anchors[${numericId - 1}] || null;
      if (!anchor) return { success: false, error: 'Headline id ${numericId} not found', available: anchors.length };
      anchor.scrollIntoView({ block: 'center' });
      anchor.click();
      return {
        success: true,
        id: ${numericId},
        href: anchor.href || null,
        headline: clean((anchor.querySelector('[class*="title"]') || anchor).innerText),
      };
    })()
  `;
  const result = await evaluateOnTarget(targetId, expression);
  if (!result?.success) {
    throw new Error(result?.error || `Could not open news headline ${numericId}`);
  }
  await new Promise(r => setTimeout(r, 500));
  return result;
}

async function readSelectedNewsDetail(targetId) {
  const payload = await extractNewsFlowPayload(targetId, { limit: 50, includeContent: true });
  if (!payload.selected_article) return null;
  return toMarkdownArticle(payload.selected_article);
}

/**
 * List all open TradingView page tabs (chart, news-flow, screener, etc).
 */
export async function list() {
  const targets = await listPageTargets();
  const tabs = targets.map(normalizeTab);

  return { success: true, tab_count: tabs.length, tabs };
}

/**
 * Open a new TradingView tab by opening a supported view URL in a new tab.
 */
export async function newTab({ view = 'chart', url } = {}) {
  const before = await list();
  const beforeIds = new Set(before.tabs.map(tab => tab.id));
  const targetUrl = url || viewUrl(view);

  await evaluate(`
    (function() {
      try {
        window.open(${JSON.stringify(targetUrl)}, '_blank');
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    })()
  `);

  for (let attempt = 0; attempt < 15; attempt += 1) {
    await new Promise(r => setTimeout(r, 300));
    const state = await list();
    const created = state.tabs.find(tab => !beforeIds.has(tab.id) && (url ? tab.url === targetUrl : tab.kind === classifyTab(targetUrl)));
    if (created) {
      return { success: true, action: 'new_tab_opened', opened: created, ...state };
    }
  }

  return {
    success: false,
    action: 'new_tab_open_attempted',
    error: `No new ${view} tab appeared after opening ${targetUrl}`,
    ...before,
  };
}

/**
 * Close the current tab via keyboard shortcut (Ctrl+W / Cmd+W).
 */
export async function closeTab() {
  const before = await list();
  if (before.tab_count <= 1) {
    throw new Error('Cannot close the last tab. Use tv_launch to restart TradingView instead.');
  }

  await evaluate(`
    (function() {
      window.close();
      return true;
    })()
  `);

  await new Promise(r => setTimeout(r, 1000));

  const after = await list();
  return { success: true, action: 'tab_closed', tabs_before: before.tab_count, tabs_after: after.tab_count };
}

/**
 * Switch to a tab by index or by a fuzzy match against kind/title/url.
 */
export async function switchTab({ index, match }) {
  const tabs = await list();
  let target;

  if (match != null) {
    target = findMatchingTab(tabs.tabs, match);
    if (!target) {
      throw new Error(`No TradingView tab matched "${match}"`);
    }
  } else {
    const idx = Number(index);
    if (idx >= tabs.tab_count || idx < 0 || !Number.isInteger(idx)) {
      throw new Error(`Tab index ${idx} out of range (have ${tabs.tab_count} tabs)`);
    }
    target = tabs.tabs[idx];
  }

  try {
    const resp = await cdpJson(`/json/activate/${target.id}`);
    const text = await resp.text();
    return {
      success: true,
      action: 'switched',
      message: text,
      index: target.index,
      kind: target.kind,
      tab_id: target.id,
      chart_id: target.chart_id,
      url: target.url,
    };
  } catch (e) {
    throw new Error(`Failed to activate tab ${target.index}: ${e.message}`);
  }
}

export async function newsFlow({ openIfMissing = true, limit, includeContent = false } = {}) {
  const extractionTarget = await ensureNewsFlowTab({ openIfMissing });
  const payload = await extractNewsFlowPayload(extractionTarget.id, { limit, includeContent });

  return {
    success: true,
    action: 'news_flow',
    switched_to: {
      index: extractionTarget.index,
      id: extractionTarget.id,
      title: extractionTarget.title,
      url: extractionTarget.url,
      kind: extractionTarget.kind,
    },
    ...payload,
  };
}

export async function listNews({ openIfMissing = true, limit, ticker } = {}) {
  const context = await ensureNewsFlowContext({ openIfMissing, ticker });
  const target = context.target;
  const payload = await readNewsHeadlines(target.id, { limit });
  return {
    success: true,
    action: 'news_list',
    filter_mode: context.filter_mode,
    ticker: ticker ? bareSymbol(context.resolved_ticker) : null,
    resolved_symbol: context.resolved_ticker,
    switched_to: {
      index: target.index,
      id: target.id,
      title: target.title,
      url: target.url,
      kind: target.kind,
    },
    ...payload,
  };
}

export async function newsDetail({ ids, openIfMissing = true } = {}) {
  const requestedIds = Array.isArray(ids)
    ? ids
    : String(ids || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean);
  if (requestedIds.length === 0) {
    throw new Error('At least one news headline id is required');
  }

  const target = await ensureNewsFlowTab({ openIfMissing });
  const details = [];
  for (const id of requestedIds) {
    const opened = await clickNewsHeadline(target.id, id);
    const article = await readSelectedNewsDetail(target.id);
    details.push({
      id: Number(id),
      href: opened.href || null,
      headline: opened.headline || null,
      markdown: article,
    });
  }

  return {
    success: true,
    action: 'news_detail',
    switched_to: {
      index: target.index,
      id: target.id,
      title: target.title,
      url: target.url,
      kind: target.kind,
    },
    detail_count: details.length,
    details,
  };
}
