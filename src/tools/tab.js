import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/tab.js';

export function registerTabTools(server) {
  server.tool('tab_list', 'List all open TradingView tabs, including chart and non-chart pages such as News Flow and Screener.', {}, async () => {
    try { return jsonResult(await core.list()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tab_new', 'Open a new TradingView tab for a built-in view or explicit TradingView URL.', {
    view: z.string().optional().describe('Built-in view name: chart, news-flow, screener'),
    url: z.string().optional().describe('Explicit TradingView URL to open'),
  }, async ({ view, url }) => {
    try { return jsonResult(await core.newTab({ view, url })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tab_close', 'Close the current chart tab', {}, async () => {
    try { return jsonResult(await core.closeTab()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tab_switch', 'Switch to a TradingView tab by index or fuzzy match against kind/title/url.', {
    index: z.coerce.number().optional().describe('Tab index (0-based, from tab_list)'),
    match: z.string().optional().describe('Match string such as news-flow, screener, or part of a title'),
  }, async ({ index, match }) => {
    try { return jsonResult(await core.switchTab({ index, match })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tab_news_flow', 'Switch to a News Flow tab, opening one if needed, and extract headlines plus optional selected-article content.', {
    open_if_missing: z.coerce.boolean().optional().describe('Open a News Flow tab if none exists'),
    limit: z.coerce.number().optional().describe('Maximum number of headlines to return'),
    include_content: z.coerce.boolean().optional().describe('Include selected article content from the detail pane'),
  }, async ({ open_if_missing, limit, include_content }) => {
    try {
      return jsonResult(await core.newsFlow({
        openIfMissing: open_if_missing,
        limit,
        includeContent: include_content,
      }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });
}
