import { register } from '../router.js';
import { getFinancials } from '../../core/financials.js';

register('financials', {
  description: 'Extract the TradingView symbol Financials overview as compact structured text. Usage: tv financials [ticker]',
  details: 'Input: optional positional ticker, or falls back to the active chart symbol.\nOutput: overview markdown, key facts, valuation summary, and available financial tab links.',
  options: {
    open: { type: 'boolean', description: 'Open a symbol Financials tab if none exists' },
  },
  output: 'financial overview markdown + tabs',
  handler: (opts, positionals) => getFinancials({
    ticker: positionals[0],
    openIfMissing: opts.open !== false,
  }),
});
