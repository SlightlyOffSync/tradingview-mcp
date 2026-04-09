import { register } from '../router.js';
import * as core from '../../core/tab.js';

register('tab', {
  description: 'Tab management (list, new, close, switch) for chart and non-chart TradingView pages',
  subcommands: new Map([
    ['list', {
      description: 'List all open TradingView tabs, including chart, news-flow, and screener views',
      handler: () => core.list(),
    }],
    ['new', {
      description: 'Open a new TradingView tab',
      options: {
        view: { type: 'string', short: 'v', example: 'news-flow', description: 'Built-in view: chart, news-flow, screener' },
        url: { type: 'string', example: 'https://www.tradingview.com/news-flow/', description: 'Explicit TradingView URL to open in a new tab' },
      },
      handler: (opts) => core.newTab({ view: opts.view, url: opts.url }),
    }],
    ['close', {
      description: 'Close the current tab',
      handler: () => core.closeTab(),
    }],
    ['switch', {
      description: 'Switch to a tab by index or fuzzy match',
      options: {
        match: { type: 'string', short: 'm', example: 'news-flow', description: 'Match a tab by kind, title, or URL' },
      },
      handler: (opts, positionals) => {
        if (opts.match) return core.switchTab({ match: opts.match });
        if (positionals[0] === undefined) throw new Error('Index required. Usage: tv tab switch 0 or tv tab switch --match news-flow');
        return core.switchTab({ index: positionals[0] });
      },
    }],
    ['news-flow', {
      description: 'Switch to a News Flow tab and return headlines as JSON',
      options: {
        open: { type: 'boolean', description: 'Open a News Flow tab if none exists' },
        limit: { type: 'string', short: 'n', example: '10', description: 'Maximum number of headlines to return' },
        content: { type: 'boolean', description: 'Include selected article content from the right-side detail pane' },
      },
      handler: (opts) => core.newsFlow({
        openIfMissing: opts.open !== false,
        limit: opts.limit ? Number(opts.limit) : undefined,
        includeContent: opts.content === true,
      }),
    }],
  ]),
});
