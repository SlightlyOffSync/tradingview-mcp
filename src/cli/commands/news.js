import { register } from '../router.js';
import * as core from '../../core/news.js';

register('news', {
  description: 'News Flow extraction from TradingView tabs',
  subcommands: new Map([
    ['list', {
      description: 'Switch to News Flow and return visible headlines as JSON',
      options: {
        open: { type: 'boolean', description: 'Open a News Flow tab if none exists' },
        ticker: { type: 'string', short: 't', example: 'TLT', description: 'Optional instrument ticker; bare tickers are resolved internally to a TradingView symbol' },
        limit: { type: 'string', short: 'n', example: '10', description: 'Optional cap on headlines to return; default is all currently rendered in the DOM' },
      },
      handler: (opts) => core.listNews({
        openIfMissing: opts.open !== false,
        ticker: opts.ticker,
        limit: opts.limit ? Number(opts.limit) : undefined,
      }),
    }],
    ['detail', {
      description: 'Open one or more News Flow headlines by id and return extracted content',
      options: {
        open: { type: 'boolean', description: 'Open a News Flow tab if none exists' },
      },
      handler: (opts, positionals) => {
        if (positionals.length === 0) {
          throw new Error('At least one id is required. Usage: tv news detail 1 or tv news detail 1 2');
        }
        return core.newsDetail({
          ids: positionals,
          openIfMissing: opts.open !== false,
        });
      },
    }],
  ]),
});
