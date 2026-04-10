import { z } from 'zod';
import { jsonResult } from './_format.js';
import { getDocuments } from '../core/documents.js';
import { getFinancials } from '../core/financials.js';

export function registerSymbolPageTools(server) {
  server.tool('documents_get', 'Open a symbol Documents page, extract the visible document list, and open each visible document action to return markdown summaries.', {
    ticker: z.string().optional().describe('Optional ticker. Bare tickers are resolved internally; default is the active chart symbol'),
    open_if_missing: z.coerce.boolean().optional().describe('Open a symbol Documents tab if none exists'),
    limit: z.coerce.number().optional().describe('Optional cap on visible document cards to extract'),
  }, async ({ ticker, open_if_missing, limit }) => {
    try {
      return jsonResult(await getDocuments({
        ticker,
        openIfMissing: open_if_missing,
        limit,
      }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  server.tool('financials_get', 'Open a symbol Financials overview page and return a compact markdown/stat summary plus available financial tabs.', {
    ticker: z.string().optional().describe('Optional ticker. Bare tickers are resolved internally; default is the active chart symbol'),
    open_if_missing: z.coerce.boolean().optional().describe('Open a symbol Financials tab if none exists'),
  }, async ({ ticker, open_if_missing }) => {
    try {
      return jsonResult(await getFinancials({
        ticker,
        openIfMissing: open_if_missing,
      }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });
}
