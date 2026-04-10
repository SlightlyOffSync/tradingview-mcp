import { register } from '../router.js';
import { getDocuments } from '../../core/documents.js';

register('documents', {
  description: 'Extract visible symbol documents and per-document markdown summaries from TradingView symbol pages. Usage: tv documents [ticker]',
  details: 'Input: optional positional ticker, or falls back to the active chart symbol.\nOutput: visible document cards plus markdown extracted from each opened transcript / filing / release dialog.',
  options: {
    open: { type: 'boolean', description: 'Open a symbol Documents tab if none exists' },
    limit: { type: 'string', short: 'n', example: '5', description: 'Optional cap on visible document cards to extract' },
  },
  output: 'visible documents + extracted markdown summaries',
  handler: (opts, positionals) => getDocuments({
    ticker: positionals[0],
    openIfMissing: opts.open !== false,
    limit: opts.limit ? Number(opts.limit) : undefined,
  }),
});
