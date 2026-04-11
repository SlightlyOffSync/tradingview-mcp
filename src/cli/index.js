#!/usr/bin/env node

/**
 * tv — CLI for TradingView Desktop via Chrome DevTools Protocol.
 * Outputs context-friendly markdown by default, or JSON via --format json.
 * Errors go to stderr.
 * Exit codes: 0 success, 1 error, 2 connection failure.
 *
 * All 70 MCP tools are accessible via CLI commands.
 * Agent-friendly by default, pipe-friendly via --format json.
 */

// Register all commands
import './commands/health.js';
import './commands/chart.js';
import './commands/data.js';
import './commands/pine.js';
import './commands/capture.js';
import './commands/replay.js';
import './commands/drawing.js';
import './commands/alerts.js';
import './commands/watchlist.js';
import './commands/layout.js';
import './commands/indicator.js';
import './commands/ui.js';
import './commands/pane.js';
import './commands/tab.js';
import './commands/news.js';
import './commands/documents.js';
import './commands/financials.js';
import './commands/stream.js';
import './commands/analyst.js';

// Run
import { run } from './router.js';
await run(process.argv);
