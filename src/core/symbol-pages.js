import CDP from 'chrome-remote-interface';
import { getState, symbolSearch } from './chart.js';
import { closeTab, list, newTab, switchTab } from './tab.js';

const CDP_HOST = 'localhost';
const CDP_PORT = 9222;
const DOCUMENT_ACTION_SELECTOR = 'button.wrap-q8y6hlvZ, button[class*="wrap-q8y6hlvZ"]';

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
          body_length: clean(document.body?.innerText || '').length
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
      const actionsSelector = ${JSON.stringify(DOCUMENT_ACTION_SELECTOR)};
      const allCards = Array.from(document.querySelectorAll('article'))
        .filter((card) => card.querySelector(actionsSelector));
      return allCards.map((card, index) => {
        const lines = String(card.innerText || '').split(/\\n+/).map(cleanText).filter(Boolean);
        let cursor = 0;
        const title = lines[cursor++] || null;
        let badge = null;
        if (/^(ANNUAL|QUARTERLY)$/i.test(lines[cursor] || '')) {
          badge = lines[cursor++];
        }
        const date = lines[cursor++] || null;
        const summary = lines[cursor++] || null;
        const actions = Array.from(card.querySelectorAll(actionsSelector)).map((button, actionIndex) => ({
          id: actionIndex + 1,
          label: cleanText(button.innerText),
        }));
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
      const actionsSelector = ${JSON.stringify(DOCUMENT_ACTION_SELECTOR)};
      const cards = Array.from(document.querySelectorAll('article'))
        .filter((card) => card.querySelector(actionsSelector));
      const card = cards[${Number(documentId) - 1}] || null;
      if (!card) return { success: false, error: 'Document not found' };
      const buttons = Array.from(card.querySelectorAll(actionsSelector));
      const button = buttons[${Number(actionId) - 1}] || null;
      if (!button) return { success: false, error: 'Document action not found' };
      button.scrollIntoView({ block: 'center' });
      button.click();
      return {
        success: true,
        label: String(button.innerText || '').replace(/\\s+/g, ' ').trim(),
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

async function extractOpenDocumentDialog(targetId, actionLabel) {
  const payload = await evaluateOnTarget(targetId, `
    (() => {
      const cleanText = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const dialog = document.querySelector('[role="dialog"], [class*="dialog-"]');
      if (!dialog) return null;
      const rawLines = String(dialog.innerText || '').split(/\\n+/).map(cleanText).filter(Boolean);
      const lines = rawLines.filter((line) => line.toLowerCase() !== 'close');
      const title = String(lines[0] || '').replace(/^Close\\s+/i, '') || null;
      const date = lines.find((line, index) => index > 0 && /^([A-Z][a-z]{2,8} \\d{1,2}, \\d{4})$/.test(line)) || null;
      const actionLabel = lines.find((line) => /transcript|report|release/i.test(line)) || null;
      const aiIndex = lines.findIndex((line) => /^AI Summary$/i.test(line));
      const contentLines = aiIndex >= 0 ? lines.slice(aiIndex + 1) : lines.slice(3);
      const sectionHeadings = /summary|highlights|guidance|performance|metrics|uncertainties|developments|financing|conditions/i;
      const sections = [];
      let current = null;
      for (const line of contentLines) {
        if (!line || /^(More|Full .*transcript)$/.test(line)) continue;
        if (sectionHeadings.test(line) && line.length < 60) {
          current = { heading: line, items: [] };
          sections.push(current);
          continue;
        }
        if (!current) {
          current = { heading: 'Summary', items: [] };
          sections.push(current);
        }
        if (!current.items.includes(line)) current.items.push(line);
      }
      return {
        title,
        date,
        action_label: ${JSON.stringify(actionLabel || null)},
        summary: lines.find((line, index) => index > 2 && !/transcript|report|release|AI Summary/i.test(line) && line.length > 30) || null,
        sections,
      };
    })()
  `);
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
        opened_tab: opened.opened_tab || null,
      });
      if (opened.action === 'dialog') {
        await closeDocumentDialog(context.target.id);
      } else if (opened.opened_tab?.id) {
        await closeOpenedDocumentTab(opened.opened_tab.id, context.target.index);
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
  return {
    success: true,
    action: 'financials_get',
    ticker: context.ticker,
    resolved_symbol: context.resolved_symbol,
    ...payload,
  };
}
