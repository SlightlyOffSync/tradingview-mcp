import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/news.js';

export function registerNewsTools(server) {
  server.tool('news_list', 'Switch to a TradingView News Flow tab and return visible headlines as JSON.', {
    open_if_missing: z.coerce.boolean().optional().describe('Open a News Flow tab if none exists'),
    ticker: z.string().optional().describe('Optional instrument ticker; bare tickers are resolved internally to a TradingView symbol'),
    limit: z.coerce.number().optional().describe('Optional cap on headlines to return; default is all currently rendered in the DOM'),
  }, async ({ open_if_missing, ticker, limit }) => {
    try {
      return jsonResult(await core.listNews({
        openIfMissing: open_if_missing,
        ticker,
        limit,
      }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  server.tool('news_detail', 'Open one or more News Flow headlines by id and return extracted article content.', {
    ids: z.array(z.coerce.number()).describe('Headline ids from news_list'),
    open_if_missing: z.coerce.boolean().optional().describe('Open a News Flow tab if none exists'),
  }, async ({ ids, open_if_missing }) => {
    try {
      return jsonResult(await core.newsDetail({
        ids,
        openIfMissing: open_if_missing,
      }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });
}
