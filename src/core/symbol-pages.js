import CDP from 'chrome-remote-interface';
import { getState, symbolSearch } from './chart.js';
import { closeTab, list, newTab, switchTab } from './tab.js';

const CDP_HOST = 'localhost';
const CDP_PORT = 9222;

function isDocumentActionLabel(value) {
  return /transcript|slides|report|release|filing/i.test(clean(value));
}

function clean(value) {
  return String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function bareSymbol(value) {
  return upper(value).split(':').pop();
}

function splitSymbol(value) {
  const [exchange, symbol] = String(value || '').split(':');
  if (!exchange || !symbol) {
    throw new Error(`Expected an exchange-qualified symbol, got "${value}"`);
  }
  return { exchange, symbol };
}

function scoreSymbolCandidate(requested, candidate) {
  const requestedUpper = upper(requested);
  const requestedBare = bareSymbol(requestedUpper);
  const fullName = upper(candidate.full_name || candidate.symbol);
  const candidateBare = bareSymbol(fullName);
  let score = 0;
  if (fullName === requestedUpper) score += 100;
  if (candidateBare === requestedBare) score += 60;
  if (candidate.exchange) score += 10;
  if (candidate.type === 'stock') score += 20;
  if (candidate.type === 'fund') score += 15;
  if (candidate.type === 'dr') score += 10;
  return score;
}

async function resolveSymbol(ticker) {
  if (ticker) {
    const requested = clean(ticker);
    if (requested.includes(':')) return requested;
    const response = await symbolSearch({ query: bareSymbol(requested) });
    const ranked = (response.results || [])
      .map((item) => ({ ...item, _score: scoreSymbolCandidate(requested, item) }))
      .sort((a, b) => b._score - a._score);
    const best = ranked[0];
    if (!best || best._score <= 0) {
      throw new Error(`Could not resolve ticker "${ticker}"`);
    }
    return best.full_name || `${best.exchange}:${best.symbol}`;
  }

  const state = await getState();
  if (!state?.symbol) {
    throw new Error('No ticker provided and no active chart symbol is available');
  }
  return state.symbol;
}

function buildSymbolPageUrl(symbol, page) {
  const { exchange, symbol: ticker } = splitSymbol(symbol);
  return `https://www.tradingview.com/symbols/${exchange}-${ticker}/${page}`;
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

async function waitForReady(targetId, expectedUrl, { requireBodyText = false, attempts = 30, delayMs = 500 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const status = await evaluateOnTarget(targetId, `
        (() => ({
          href: location.href,
          ready: document.readyState,
          body_length: String(document.body?.innerText || '').replace(/[\\u200B-\\u200D\\uFEFF]/g, '').replace(/\\s+/g, ' ').trim().length
        }))()
      `);
      const urlMatches = !expectedUrl || String(status.href || '').startsWith(expectedUrl);
      const bodyMatches = !requireBodyText || Number(status.body_length || 0) > 200;
      if (status.ready === 'complete' && urlMatches && bodyMatches) return status;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

async function ensureSymbolPage({ ticker, page, openIfMissing = true, requireBodyText = true } = {}) {
  const resolvedSymbol = await resolveSymbol(ticker);
  const pageUrl = buildSymbolPageUrl(resolvedSymbol, page);
  let state = await list();
  let target = state.tabs.find((tab) => String(tab.url || '').startsWith(pageUrl));

  if (!target && openIfMissing) {
    const created = await newTab({ url: pageUrl });
    if (!created.success || !created.opened) {
      throw new Error(created.error || `Could not open ${pageUrl}`);
    }
    state = await list();
    target = state.tabs.find((tab) => tab.id === created.opened.id) || created.opened;
  }

  if (!target) {
    throw new Error(`No open tab for ${pageUrl}`);
  }

  await switchTab({ index: target.index });
  await waitForReady(target.id, pageUrl, { requireBodyText });

  return {
    target,
    page_url: pageUrl,
    resolved_symbol: resolvedSymbol,
    ticker: bareSymbol(resolvedSymbol),
  };
}

function linesToMarkdown(lines = []) {
  return lines.filter(Boolean).join('\n');
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeDocumentButtonLabel(value) {
  return clean(value)
    .replace(/\bEarning\b/gi, 'Earnings')
    .replace(/\btran cript\b/gi, 'transcript')
    .replace(/\brelea e\b/gi, 'release');
}

async function readDocumentCards(targetId, { limit } = {}) {
  const cards = await evaluateOnTarget(targetId, `
    (() => {
      const cleanText = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const isAction = (value) => /transcript|slides|report|release|filing/i.test(cleanText(value));
      const getActions = (card) => Array.from(card.querySelectorAll('button, [role="button"], a'))
        .map((node, actionIndex) => ({
          id: actionIndex + 1,
          label: cleanText(node.innerText || node.getAttribute?.('aria-label') || ''),
          tag: node.tagName,
        }))
        .filter((item) => item.label && isAction(item.label));
      const allCards = Array.from(document.querySelectorAll('article'))
        .map((card) => ({ card, actions: getActions(card) }))
        .filter((item) => item.actions.length > 0);
      return allCards.map(({ card, actions }, index) => {
        const lines = String(card.innerText || '').split(/\\n+/).map(cleanText).filter(Boolean);
        let cursor = 0;
        const title = lines[cursor++] || null;
        let badge = null;
        if (/^(ANNUAL|QUARTERLY)$/i.test(lines[cursor] || '')) {
          badge = lines[cursor++];
        }
        const date = lines[cursor++] || null;
        const summary = lines[cursor++] || null;
        return {
          id: index + 1,
          title,
          badge,
          date,
          summary,
          action_count: actions.length,
          actions,
        };
      });
    })()
  `);

  const sliced = limit ? cards.slice(0, Math.max(1, Number(limit) || 1)) : cards;
  return sliced.map((card) => ({
    ...card,
    actions: (card.actions || []).map((action) => ({
      ...action,
      label: normalizeDocumentButtonLabel(action.label),
    })),
  }));
}

async function closeDocumentDialog(targetId) {
  await evaluateOnTarget(targetId, `
    (() => {
      const closeButton = Array.from(document.querySelectorAll('button, [role="button"]')).find((node) => {
        const label = String(node.getAttribute?.('aria-label') || '');
        const text = String(node.innerText || '');
        return /close/i.test(label) || /^close$/i.test(text.trim());
      });
      if (closeButton) {
        closeButton.click();
        return true;
      }
      const active = document.querySelector('[role="dialog"], [class*="dialog-"]');
      if (active && active.parentElement) {
        active.parentElement.removeChild(active);
        return true;
      }
      return false;
    })()
  `);
}

async function openDocumentAction(targetId, documentId, actionId) {
  const tabsBefore = await list();
  const knownIds = new Set(tabsBefore.tabs.map((tab) => tab.id));
  await closeDocumentDialog(targetId);
  const result = await evaluateOnTarget(targetId, `
    (() => {
      const cleanText = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const isAction = (value) => /transcript|slides|report|release|filing/i.test(cleanText(value));
      const getActions = (card) => Array.from(card.querySelectorAll('button, [role="button"], a'))
        .filter((node) => isAction(node.innerText || node.getAttribute?.('aria-label') || ''));
      const cards = Array.from(document.querySelectorAll('article'))
        .filter((card) => getActions(card).length > 0);
      const card = cards[${Number(documentId) - 1}] || null;
      if (!card) return { success: false, error: 'Document not found' };
      const buttons = getActions(card);
      const button = buttons[${Number(actionId) - 1}] || null;
      if (!button) return { success: false, error: 'Document action not found' };
      button.scrollIntoView({ block: 'center' });
      button.click();
      return {
        success: true,
        label: cleanText(button.innerText || button.getAttribute?.('aria-label') || ''),
      };
    })()
  `);
  if (!result?.success) {
    throw new Error(result?.error || 'Could not open document action');
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const ready = await evaluateOnTarget(targetId, `
      (() => ({
        dialogs: document.querySelectorAll('[role="dialog"], [class*="dialog-"]').length
      }))()
    `);
    if (Number(ready.dialogs || 0) > 0) {
      return {
        action: 'dialog',
        label: normalizeDocumentButtonLabel(result.label),
      };
    }
    const tabsAfter = await list();
    const created = tabsAfter.tabs.find((tab) => !knownIds.has(tab.id));
    if (created) {
      return {
        action: 'tab',
        label: normalizeDocumentButtonLabel(result.label),
        opened_tab: created,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Document action "${result.label}" did not open a dialog or tab`);
}

async function activateAiSummary(targetId) {
  await evaluateOnTarget(targetId, `
    (() => {
      const button = Array.from(document.querySelectorAll('button, [role="button"]')).find((node) =>
        /^AI Summary$/i.test(String(node.innerText || '').trim()));
      if (!button) return false;
      button.click();
      return true;
    })()
  `);
}

function formatDocumentMarkdown(payload) {
  if (!payload) return null;
  const lines = [];
  if (payload.title) lines.push(`# ${payload.title}`);
  if (payload.date) lines.push(`- Date: ${payload.date}`);
  if (payload.action_label) lines.push(`- Document: ${payload.action_label}`);
  if (payload.summary) {
    lines.push('');
    lines.push(payload.summary);
  }
  for (const section of payload.sections || []) {
    lines.push('');
    lines.push(`## ${section.heading}`);
    for (const item of section.items || []) {
      lines.push(`- ${item}`);
    }
  }
  return linesToMarkdown(lines);
}

function normalizeDocumentPayload(payload) {
  if (!payload) return payload;
  const noisyLabels = new Set([
    'Event transcript',
    'Call transcript',
    'Press release',
    'Slides',
    'Annual report',
    'Quarterly report',
    'Earnings release',
    'AI Summary',
  ]);

  const summary = clean(payload.summary);
  const normalizedSections = [];
  const seenItems = new Set();
  const selectedItems = [];

  function isRedundantItem(item) {
    return selectedItems.some((existing) =>
      existing === item
      || existing.includes(item)
      || item.includes(existing));
  }

  for (const section of payload.sections || []) {
    const heading = clean(section.heading);
    const items = [];
    for (const rawItem of section.items || []) {
      const item = clean(rawItem);
      if (!item) continue;
      if (noisyLabels.has(item)) continue;
      if (summary && item === summary) continue;
      if (/^full .*transcript$/i.test(item)) continue;
      if (item.length < 8 && !/[0-9]/.test(item)) continue;
      if (seenItems.has(item)) continue;
      if (isRedundantItem(item)) continue;
      seenItems.add(item);
      selectedItems.push(item);
      items.push(item);
    }
    if (items.length === 0) continue;
    normalizedSections.push({ heading: heading || 'Summary', items });
  }

  const cleanedSummary = !summary || noisyLabels.has(summary) || /^slides$/i.test(summary)
    ? null
    : summary;

  return {
    ...payload,
    summary: cleanedSummary,
    sections: normalizedSections,
    has_substantive_content: Boolean(cleanedSummary || normalizedSections.length > 0),
  };
}

async function extractOpenDocumentDialog(targetId, actionLabel) {
  const rawPayload = await evaluateOnTarget(targetId, `
    (() => {
      const cleanText = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const dialog = document.querySelector('[role="dialog"], [class*="dialog-"]');
      if (!dialog) return null;
      const rawLines = String(dialog.innerText || '').split(/\\n+/).map(cleanText).filter(Boolean);
      const lines = rawLines.filter((line) => line.toLowerCase() !== 'close');
      const title = String(lines[0] || '').replace(/^Close\\s+/i, '') || null;
      const date = lines.find((line, index) => index > 0 && /^([A-Z][a-z]{2,8} \\d{1,2}, \\d{4})$/.test(line)) || null;
      const actionLabel = lines.find((line) => /transcript|report|release|slides/i.test(line)) || null;

      const contentNodes = Array.from(dialog.querySelectorAll('h1, h2, h3, h4, p, li'))
        .map((node) => ({
          tag: node.tagName,
          text: cleanText(node.innerText),
        }))
        .filter((item) => item.text);

      const noisy = /^(close|ai summary|event transcript|call transcript|press release|slides|annual report|quarterly report|earnings release|full .*transcript|more)$/i;
      const sectionHeading = /summary|highlights|guidance|performance|metrics|uncertainties|developments|financing|conditions|outlook|risks|strategy|market|introduction|conclusion|q&a/i;
      const sections = [];
      let current = null;

      for (const item of contentNodes) {
        const text = item.text;
        if (!text || noisy.test(text)) continue;
        if (text === title || text === date || text === ${JSON.stringify(actionLabel || null)}) continue;
        if (/^([A-Z][a-z]{2,8} \\d{1,2}, \\d{4})$/.test(text)) continue;
        const isHeading = /^H[1-4]$/.test(item.tag) || (sectionHeading.test(text) && text.length < 70);
        if (isHeading) {
          current = { heading: text, items: [] };
          sections.push(current);
          continue;
        }
        if (!current) {
          current = { heading: 'Summary', items: [] };
          sections.push(current);
        }
        if (!current.items.includes(text)) current.items.push(text);
      }

      const paragraphTexts = contentNodes
        .filter((item) => item.tag === 'P' || item.tag === 'LI')
        .map((item) => item.text)
        .filter((text) => !noisy.test(text) && text !== title && text !== date);

      return {
        title,
        date,
        action_label: ${JSON.stringify(actionLabel || null)},
        summary: paragraphTexts.find((line) => line.length > 35) || null,
        sections,
      };
    })()
  `);
  const payload = normalizeDocumentPayload(rawPayload);
  return {
    ...payload,
    markdown: formatDocumentMarkdown(payload),
  };
}

function formatOpenedTabMarkdown({ title, url, actionLabel }) {
  const lines = [
    `# ${actionLabel}`,
    '',
    `Opened a document tab instead of an in-page dialog.`,
  ];
  if (title) lines.push(`- Title: ${title}`);
  if (url) lines.push(`- URL: ${url}`);
  return linesToMarkdown(lines);
}

async function readOpenedDocumentTab(tab) {
  const title = clean(tab?.title || '');
  const url = String(tab?.url || '');
  return {
    title: title || null,
    url: url || null,
    markdown: formatOpenedTabMarkdown({
      title: title || null,
      url: url || null,
      actionLabel: 'Document file',
    }),
  };
}

async function closeOpenedDocumentTab(tabId, returnToTabIndex) {
  const state = await list();
  const tab = state.tabs.find((item) => item.id === tabId);
  if (!tab) return;
  await switchTab({ index: tab.index });
  await closeTab();
  if (Number.isInteger(returnToTabIndex)) {
    const refreshed = await list();
    const safeIndex = Math.min(returnToTabIndex, refreshed.tab_count - 1);
    if (safeIndex >= 0) await switchTab({ index: safeIndex });
  }
}

function parseFinancialBlock(lines, startLabel, endLabels = []) {
  const startIndex = lines.indexOf(startLabel);
  if (startIndex < 0) return [];
  const endIndex = lines.findIndex((line, index) =>
    index > startIndex && endLabels.includes(line));
  return lines.slice(startIndex + 1, endIndex > -1 ? endIndex : undefined);
}

function pairLines(lines = []) {
  const pairs = [];
  for (let index = 0; index < lines.length - 1; index += 2) {
    pairs.push({ label: lines[index], value: lines[index + 1] });
  }
  return pairs;
}

function normalizeFinancialTabName(value) {
  return clean(value)
    .replace(/\bFinancial\b/i, 'Financials')
    .replace(/\bStatement\b/i, 'Statements')
    .replace(/\bStati tic\b/i, 'Statistics')
    .replace(/\bDividend\b/i, 'Dividends')
    .replace(/\bEarning\b/i, 'Earnings')
    .replace(/\bFinancials health\b/i, 'Financial health')
    .replace(/\bBa ic\b/gi, 'Basic')
    .replace(/\bEmployee \b/gi, 'Employees ')
    .replace(/\bBalance  heet\b/gi, 'Balance sheet')
    .replace(/\bCa h flow\b/gi, 'Cash flow');
}

function findLineValue(lines, label) {
  const index = lines.indexOf(label);
  if (index < 0) return null;
  const value = clean(lines[index + 1] || '');
  if (!value) return null;
  const knownLabels = new Set([
    'Report period',
    'EPS estimate',
    'Revenue estimate',
    'Last ex-dividend date',
    'Last payment date',
    'Dividend amount',
    'Dividend yield TTM',
  ]);
  if (knownLabels.has(value)) return null;
  return value;
}

function buildFinancialSectionMarkdown(sectionName, payload) {
  const lines = payload.lines || [];
  const summary = clean(payload.summary);
  const pageUrl = payload.href || payload.page_url || null;
  const parts = [`## ${sectionName}`];
  if (pageUrl) parts.push(`- URL: ${pageUrl}`);
  if (summary) parts.push(summary);

  if (sectionName === 'Earnings') {
    const reportPeriod = findLineValue(lines, 'Report period');
    const epsEstimate = findLineValue(lines, 'EPS estimate');
    const revenueEstimate = findLineValue(lines, 'Revenue estimate');
    if (reportPeriod) parts.push(`- Next report period: ${reportPeriod}`);
    if (epsEstimate) parts.push(`- EPS estimate: ${epsEstimate}`);
    if (revenueEstimate) parts.push(`- Revenue estimate: ${revenueEstimate}`);
    if (payload.table_rows?.length) {
      parts.push('### Recent Estimate Table');
      parts.push(...payload.table_rows.map((row) => {
        const cells = row.periods.filter((p) => p.value).map((p) => `${p.period}: ${p.value}`).join(' | ');
        return `- ${row.label}: ${cells}`;
      }));
    }
    return linesToMarkdown(parts);
  }

  if (sectionName === 'Dividends') {
    const dividendAmount = findLineValue(lines, 'Dividend amount');
    const dividendYield = findLineValue(lines, 'Dividend yield TTM');
    const exDate = findLineValue(lines, 'Last ex-dividend date');
    const paymentDate = findLineValue(lines, 'Last payment date');
    if (dividendAmount) parts.push(`- Dividend amount: ${dividendAmount}`);
    if (dividendYield) parts.push(`- Dividend yield TTM: ${dividendYield}`);
    if (exDate) parts.push(`- Last ex-dividend date: ${exDate}`);
    if (paymentDate) parts.push(`- Last payment date: ${paymentDate}`);
    return linesToMarkdown(parts);
  }

  if (sectionName === 'Statements') {
    const keyLabels = ['Total revenue', 'Gross profit', 'Operating income', 'Pretax income'];
    const labels = keyLabels.filter((label) => lines.includes(label));
    if (labels.length > 0) parts.push(`- Metrics: ${labels.join(', ')}`);
    return linesToMarkdown(parts);
  }

  if (sectionName === 'Statistics') {
    const keyLabels = [
      'Price-to-sales ratio',
      'Enterprise value to EBITDA ratio',
      'Employees',
    ].filter((label) => lines.includes(label));
    if (keyLabels.length > 0) parts.push(`- Focus: ${keyLabels.join(', ')}`);
    if (payload.table_rows?.length) {
      parts.push('### Recent Table Data');
      parts.push(...payload.table_rows.map((row) => {
        const cells = row.periods.filter((p) => p.value).map((p) => `${p.period}: ${p.value}`).join(' | ');
        return `- ${row.label}: ${cells}`;
      }));
    }
    return linesToMarkdown(parts);
  }

  if (sectionName === 'Revenue') {
    const modes = ['By source', 'By country'].filter((label) => lines.includes(label));
    if (modes.length > 0) parts.push(`- Breakdown views: ${modes.join(', ')}`);
    if (payload.table_rows?.length) {
      parts.push('### Recent Table Data');
      parts.push(...payload.table_rows.map((row) => {
        const cells = row.periods.filter((p) => p.value).map((p) => `${p.period}: ${p.value}`).join(' | ');
        return `- ${row.label}: ${cells}`;
      }));
    }
    return linesToMarkdown(parts);
  }

  if (sectionName === 'Financial health') {
    const keyLabels = ['Total assets', 'Total liabilities', 'Total equity', 'Total debt', 'Net debt']
      .filter((label) => lines.includes(label));
    if (keyLabels.length > 0) parts.push(`- Balance sheet lines: ${keyLabels.join(', ')}`);
    return linesToMarkdown(parts);
  }

  return linesToMarkdown(parts);
}

function isFinancialPeriodLabel(line) {
  return /^Q[1-4] '\d{2}$/.test(line) || /^TTM$/.test(line);
}

function isFinancialDateLabel(line) {
  return /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) 20\d{2}$/.test(line);
}

function isNumericLike(line) {
  return /[0-9]/.test(line) && !isFinancialPeriodLabel(line) && !isFinancialDateLabel(line);
}

function parseFinancialTableSeries(lines = []) {
  const currencyIndex = lines.indexOf('Currency: USD');
  if (currencyIndex < 0) return { periods: [], metrics: [] };

  const periods = [];
  let cursor = currencyIndex + 1;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (isFinancialPeriodLabel(line)) {
      periods.push(line);
      cursor += 1;
      if (isFinancialDateLabel(lines[cursor] || '')) cursor += 1;
      continue;
    }
    break;
  }

  const metrics = [];
  while (cursor < lines.length) {
    const label = clean(lines[cursor] || '');
    if (!label) {
      cursor += 1;
      continue;
    }
    if (/^(Annual|Quarterly|More|Currency: USD)$/.test(label)) {
      cursor += 1;
      continue;
    }
    if (isFinancialPeriodLabel(label) || isFinancialDateLabel(label)) break;
    if (isNumericLike(label)) {
      cursor += 1;
      continue;
    }

    let hasGrowth = clean(lines[cursor + 1] || '') === 'YoY growth';
    cursor += hasGrowth ? 2 : 1;
    const values = [];
    const growth = [];

    for (let index = 0; index < periods.length && cursor < lines.length; index += 1) {
      const value = clean(lines[cursor] || '');
      if (!isNumericLike(value)) break;
      values.push(value);
      cursor += 1;
      if (hasGrowth) {
        const growthValue = clean(lines[cursor] || '');
        if (!isNumericLike(growthValue)) break;
        growth.push(growthValue);
        cursor += 1;
      }
    }

    if (values.length > 0) {
      metrics.push({ label, values, growth });
      continue;
    }
  }

  return { periods, metrics };
}

function pickRecentMetricRows(series, labels, count = 4) {
  const periods = series.periods || [];
  const recentPeriods = periods.slice(-count);
  const rows = [];

  for (const label of labels) {
    const metric = (series.metrics || []).find((item) => item.label === label);
    if (!metric) continue;
    const recentValues = metric.values.slice(-recentPeriods.length);
    const recentGrowth = metric.growth?.slice(-recentPeriods.length) || [];
    rows.push({
      label,
      periods: recentPeriods.map((period, index) => ({
        period,
        value: recentValues[index] || null,
        growth: recentGrowth[index] || null,
      })),
    });
  }

  return rows;
}

function normalizeSeriesLabel(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\bstate\b/g, 'states')
    .replace(/\bgraphic\b/g, 'graphics')
    .replace(/\bestimate\b/g, 'estimate')
    .replace(/\breported\b/g, 'reported')
    .replace(/\bsurprise\b/g, 'surprise')
    .trim();
}

function parseRevenueBlocks(lines = []) {
  const sections = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line !== 'By source' && line !== 'By country') continue;
    const mode = line === 'By source' ? 'source' : 'country';
    let cursor = index + 1;
    const years = [];
    while (cursor < lines.length && /^20\d{2}$/.test(lines[cursor])) {
      years.push(lines[cursor]);
      cursor += 1;
    }
    while (cursor < lines.length && isNumericLike(lines[cursor])) {
      cursor += 1;
    }
    const legendLabels = [];
    while (cursor < lines.length) {
      const label = clean(lines[cursor] || '');
      if (!label) {
        cursor += 1;
        continue;
      }
      if (label === 'Currency: USD') {
        cursor += 1;
        break;
      }
      if (label === 'By source' || label === 'By country') break;
      if (/^(Overview|Statements|Statistics|Dividends|Earnings|Revenue|More|Show more)$/.test(label)) break;
      if (isNumericLike(label) || /^20\d{2}$/.test(label)) {
        cursor += 1;
        continue;
      }
      legendLabels.push(label);
      cursor += 1;
    }

    const dataYears = [];
    while (cursor < lines.length && /^20\d{2}$/.test(lines[cursor])) {
      dataYears.push(lines[cursor]);
      cursor += 1;
    }

    const activeYears = dataYears.length > 0 ? dataYears : years;
    const rows = [];
    while (cursor < lines.length) {
      const label = clean(lines[cursor] || '');
      if (!label) {
        cursor += 1;
        continue;
      }
      if (label === 'By source' || label === 'By country') break;
      if (/^(Overview|Statements|Statistics|Dividends|Earnings|Revenue|More|Show more)$/.test(label)) break;
      if (isNumericLike(label) || /^20\d{2}$/.test(label)) {
        cursor += 1;
        continue;
      }
      cursor += 1;
      const values = [];
      while (cursor < lines.length && (isNumericLike(lines[cursor]) || lines[cursor] === '—')) {
        values.push(lines[cursor]);
        cursor += 1;
      }
      if (values.length > 0) rows.push({ label, values });
    }
    sections.push({ mode, years: activeYears, legend_labels: legendLabels, rows });
  }
  return sections;
}

function pickRecentRevenueRows(sections = [], mode, labels = [], count = 3) {
  const section = sections.find((item) => item.mode === mode);
  if (!section) return [];
  const years = section.years.slice(-count);
  return labels.flatMap((label) => {
    const normalized = normalizeSeriesLabel(label);
    const row = section.rows.find((item) => normalizeSeriesLabel(item.label) === normalized);
    if (!row) return [];
    const values = row.values.slice(-years.length);
    return [{
      label,
      periods: years.map((year, index) => ({
        period: year,
        value: values[index] || null,
        growth: null,
      })),
    }];
  });
}

function parseEarningsSeries(lines = []) {
  const start = lines.indexOf('FORECAST');
  if (start < 0) return { periods: [], rows: [] };
  const periods = [];
  let cursor = start + 1;
  while (cursor < lines.length && isFinancialPeriodLabel(lines[cursor])) {
    periods.push(lines[cursor]);
    cursor += 1;
  }
  while (cursor < lines.length && isNumericLike(lines[cursor])) {
    cursor += 1;
  }
  while (cursor < lines.length && !/^Currency: USD$/.test(lines[cursor])) {
    if (lines[cursor] === 'Revenue' || lines[cursor] === 'Annual' || lines[cursor] === 'Quarterly' || lines[cursor] === 'More') {
      return { periods, rows: [] };
    }
    cursor += 1;
  }
  if (lines[cursor] === 'Currency: USD') cursor += 1;
  const dataPeriods = [];
  while (cursor < lines.length && isFinancialPeriodLabel(lines[cursor])) {
    dataPeriods.push(lines[cursor]);
    cursor += 1;
  }
  const rows = [];
  while (cursor < lines.length) {
    const label = clean(lines[cursor] || '');
    if (!label) {
      cursor += 1;
      continue;
    }
    if (/^(Annual|Quarterly|More|Currency: USD|By source|By country|Revenue)$/.test(label)) break;
    if (isFinancialPeriodLabel(label) || isNumericLike(label)) {
      cursor += 1;
      continue;
    }
    cursor += 1;
    const values = [];
    while (cursor < lines.length && (isNumericLike(lines[cursor]) || lines[cursor] === '—')) {
      values.push(lines[cursor]);
      cursor += 1;
    }
    if (values.length > 0) rows.push({ label, values });
    else break;
  }
  return { periods: dataPeriods.length > 0 ? dataPeriods : periods, rows };
}

function pickRecentEarningsRows(series, labels = [], count = 6) {
  const periods = (series.periods || []).slice(-count);
  return labels.flatMap((label) => {
    const normalized = normalizeSeriesLabel(label);
    const row = (series.rows || []).find((item) => normalizeSeriesLabel(item.label) === normalized);
    if (!row) return [];
    const values = row.values.slice(-periods.length);
    return [{
      label,
      periods: periods.map((period, index) => ({
        period,
        value: values[index] || null,
        growth: null,
      })),
    }];
  });
}

function financialTabCategory(href) {
  const url = String(href || '');
  if (url.includes('/financials-overview/')) return 'overview';
  if (url.includes('/financials-income-statement/')) return 'statements';
  if (url.includes('/financials-statistics-and-ratios/')) return 'statistics';
  if (url.includes('/financials-dividends/')) return 'dividends';
  if (url.includes('/financials-earnings/')) return 'earnings';
  if (url.includes('/financials-revenue/')) return 'revenue';
  if (url.includes('/financials-balance-sheet/')) return 'balance_sheet';
  if (url.includes('/financials-cash-flow/')) return 'cash_flow';
  return null;
}

function pickFinancialTabs(tabs = []) {
  const prioritized = uniqueBy(
    tabs
      .map((tab) => ({
        name: normalizeFinancialTabName(tab.name),
        href: String(tab.href || ''),
        category: financialTabCategory(tab.href),
      }))
      .filter((tab) => tab.category),
    (tab) => tab.category,
  );
  const order = ['overview', 'statements', 'statistics', 'dividends', 'earnings', 'revenue', 'balance_sheet', 'cash_flow'];
  return prioritized.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
}

async function openPageTarget(url, { openIfMissing = true } = {}) {
  let state = await list();
  let target = state.tabs.find((tab) => String(tab.url || '').startsWith(url));

  if (!target && openIfMissing) {
    const created = await newTab({ url });
    if (!created.success || !created.opened) {
      throw new Error(created.error || `Could not open ${url}`);
    }
    state = await list();
    target = state.tabs.find((tab) => tab.id === created.opened.id) || created.opened;
  }

  if (!target) throw new Error(`No open tab for ${url}`);

  await switchTab({ index: target.index });
  await waitForReady(target.id, url, { requireBodyText: true });
  return target;
}

async function readFinancialTabPage(targetId, sectionName) {
  const payload = await evaluateOnTarget(targetId, `
    (() => {
      const cleanText = (value) => String(value || '').replace(/[\\u200B-\\u200D\\uFEFF]/g, '').replace(/\\s+/g, ' ').trim();
      const main = document.querySelector('main') || document.body;
      const lines = String(main?.innerText || '').split(/\\n+/).map(cleanText).filter(Boolean);
      const headings = Array.from(main.querySelectorAll('h1, h2, h3'))
        .map((node) => cleanText(node.innerText))
        .filter(Boolean);
      return {
        title: document.title,
        href: location.href,
        headings,
        lines,
      };
    })()
  `);

  const title = clean(payload.title).replace(' – TradingView', '');
  const headings = (payload.headings || []).filter(Boolean);
  const lines = (payload.lines || []).filter(Boolean);
  const summary = lines.find((line) =>
    line.length > 60
    && !/^As of today /i.test(line)
    && !/OverviewFinancialsNewsDocumentsCommunityTechnicalsForecastsSeasonalsOptionsBondsETFs/i.test(line)
    && !/^(Overview|Statements|Statistics|Dividends|Earnings|Revenue|More)$/i.test(line)
    && line !== title
    && !headings.includes(line)) || null;

  const trimmedLines = [];
  let started = false;
  for (const line of lines) {
    if (!started) {
      if (headings.includes(line) || line === sectionName || line === title) started = true;
      else continue;
    }
    if (/^OverviewFinancialsNewsDocumentsCommunityTechnicalsForecastsSeasonalsOptionsBondsETFs$/i.test(line)) continue;
    if (/^More$/.test(line) && trimmedLines.length === 0) continue;
    trimmedLines.push(line);
    if (trimmedLines.length >= 80) break;
  }

  const series = parseFinancialTableSeries(lines);
  let table_rows = [];
  if (sectionName === 'Statements') {
    table_rows = pickRecentMetricRows(series, ['Total revenue', 'Gross profit', 'Operating income', 'Pretax income', 'Net income']);
  } else if (sectionName === 'Statistics') {
    table_rows = pickRecentMetricRows(series, [
      'Price to earnings ratio',
      'Price to sales ratio',
      'Enterprise value to EBITDA ratio',
      'Current ratio',
      'Debt to equity ratio',
    ]);
  } else if (sectionName === 'Earnings') {
    table_rows = pickRecentEarningsRows(parseEarningsSeries(lines), ['Reported', 'Estimate', 'Surprise']);
  } else if (sectionName === 'Revenue') {
    const revenueSections = parseRevenueBlocks(lines);
    table_rows = [
      ...pickRecentRevenueRows(revenueSections, 'source', ['Compute & Networking', 'Graphics'], 3),
      ...pickRecentRevenueRows(revenueSections, 'country', ['United States', 'Taiwan', 'China (Including Hong Kong)'], 3),
    ];
  } else if (sectionName === 'Financial health') {
    table_rows = pickRecentMetricRows(series, ['Total assets', 'Total liabilities', 'Total equity', 'Total debt', 'Net debt']);
  }
  const markdown = buildFinancialSectionMarkdown(sectionName, {
    ...payload,
    summary,
    table_rows,
  });

  return {
    name: sectionName,
    page_title: payload.title,
    page_url: payload.href,
    headings,
    summary,
    table_periods: series.periods,
    table_rows,
    excerpt_lines: trimmedLines.slice(0, 60),
    markdown,
  };
}

async function readFinancialsPage(targetId) {
  const payload = await evaluateOnTarget(targetId, `
    (() => {
      const cleanText = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const lines = String(document.body.innerText || '').split(/\\n+/).map(cleanText).filter(Boolean);
      const tabs = Array.from(document.querySelectorAll('a[href*="/financials-"]'))
        .map((anchor) => ({
          name: cleanText(anchor.innerText),
          href: anchor.href,
        }))
        .filter((item, index, arr) => item.name && arr.findIndex((other) => other.href === item.href) === index);
      return {
        title: document.title,
        href: location.href,
        lines,
        tabs,
      };
    })()
  `);

  const keyFactsLines = parseFinancialBlock(payload.lines, 'Key facts', ['About']);
  const aboutLines = parseFinancialBlock(payload.lines, 'About', ['Show more', 'Ownership']);
  const valuationLines = parseFinancialBlock(payload.lines, 'Valuation', ['Growth and Profitability']);

  const keyFacts = pairLines(keyFactsLines);
  const valuationSummaryStart = valuationLines.indexOf('Summary');
  const valuationSummary = valuationSummaryStart > -1
    ? valuationLines.slice(valuationSummaryStart + 1, valuationLines.indexOf('Valuation ratios') > -1 ? valuationLines.indexOf('Valuation ratios') : undefined)
    : [];
  const valuationPairs = [];
  if (valuationSummary[0]) valuationPairs.push({ label: 'Market Cap', value: valuationSummary[0] });
  for (let index = 1; index < valuationSummary.length - 1; index += 2) {
    const label = valuationSummary[index];
    const value = valuationSummary[index + 1];
    if (/^(Market Cap|Net income|Revenue|Valuation ratios)$/i.test(value)) continue;
    valuationPairs.push({ label, value });
  }

  const markdown = linesToMarkdown([
    `# ${clean(payload.title).replace(' – TradingView', '')}`,
    '',
    '## Key Facts',
    ...keyFacts.map((item) => `- ${item.label}: ${item.value}`),
    '',
    '## About',
    aboutLines.join(' '),
    '',
    '## Valuation',
    ...valuationPairs.map((item) => `- ${item.label}: ${item.value}`),
  ]);

  return {
    page_title: payload.title,
    page_url: payload.href,
    tabs: payload.tabs,
    key_facts: keyFacts,
    about: aboutLines.join(' '),
    valuation: valuationPairs,
    markdown,
  };
}

export async function getDocuments({ ticker, openIfMissing = true, limit } = {}) {
  const context = await ensureSymbolPage({ ticker, page: 'documents/', openIfMissing });
  const documents = await readDocumentCards(context.target.id, { limit });
  const details = [];

  for (const document of documents) {
    const actions = [];
    for (const action of document.actions || []) {
      try {
        const opened = await openDocumentAction(context.target.id, document.id, action.id);
        if (opened.action === 'dialog' && /transcript/i.test(opened.label)) {
          await activateAiSummary(context.target.id);
        }
        const detail = opened.action === 'dialog'
          ? await extractOpenDocumentDialog(context.target.id, opened.label)
          : await readOpenedDocumentTab(opened.opened_tab);
        actions.push({
          id: action.id,
          label: opened.label,
          markdown: detail?.markdown || null,
          has_substantive_content: detail?.has_substantive_content ?? Boolean(detail?.summary || detail?.sections?.length),
          opened_tab: opened.opened_tab || null,
        });
        if (opened.action === 'dialog') {
          await closeDocumentDialog(context.target.id);
        } else if (opened.opened_tab?.id) {
          await closeOpenedDocumentTab(opened.opened_tab.id, context.target.index);
        }
      } catch (err) {
        actions.push({
          id: action.id,
          label: action.label,
          markdown: null,
          has_substantive_content: false,
          error: err.message,
          opened_tab: null,
        });
        await closeDocumentDialog(context.target.id);
      }
    }
    details.push({ ...document, details: actions });
  }

  return {
    success: true,
    action: 'documents_get',
    ticker: context.ticker,
    resolved_symbol: context.resolved_symbol,
    page_url: context.page_url,
    document_count: details.length,
    documents: details,
  };
}

export async function getFinancials({ ticker, openIfMissing = true } = {}) {
  const context = await ensureSymbolPage({ ticker, page: 'financials-overview/', openIfMissing });
  const payload = await readFinancialsPage(context.target.id);
  const sectionTabs = pickFinancialTabs(payload.tabs || []).filter((tab) => tab.category !== 'overview');
  const sections = [];

  for (const tab of sectionTabs) {
    try {
      const target = await openPageTarget(tab.href, { openIfMissing: true });
      sections.push(await readFinancialTabPage(target.id, tab.name));
    } catch (err) {
      sections.push({
        name: tab.name,
        page_url: tab.href,
        error: err.message,
        markdown: `## ${tab.name}\n- URL: ${tab.href}\n- Error: ${err.message}`,
      });
    }
  }

  const markdown = linesToMarkdown([
    payload.markdown,
    '',
    ...sections.flatMap((section) => [section.markdown, '']),
  ]).trim();

  return {
    success: true,
    action: 'financials_get',
    ticker: context.ticker,
    resolved_symbol: context.resolved_symbol,
    ...payload,
    sections,
    markdown,
  };
}
