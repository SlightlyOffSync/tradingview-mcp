/**
 * CLI command router using node:util parseArgs.
 * Zero dependencies — uses only Node.js built-ins.
 */
import { parseArgs } from 'node:util';
import { toContextText } from '../tools/_format.js';

/** @type {Map<string, { description: string, options?: object, handler: Function, subcommands?: Map<string, object> }>} */
const commands = new Map();

export function register(name, config) {
  commands.set(name, config);
}

function parseArgsOptions(options = {}) {
  return Object.fromEntries(
    Object.entries(options).map(([name, config]) => [
      name,
      { type: config.type, ...(config.short ? { short: config.short } : {}) },
    ]),
  );
}

function printOptions(options = {}) {
  if (Object.keys(options).length === 0) return;
  console.log('\nOptions:');
  for (const [k, v] of Object.entries(options)) {
    const flag = v.short ? `-${v.short}, --${k}` : `    --${k}`;
    const meta = [
      v.required ? 'required' : null,
      v.type === 'string' && v.example ? `example: ${v.example}` : null,
      v.type === 'boolean' ? 'flag' : null,
    ].filter(Boolean).join('; ');
    const suffix = meta ? ` (${meta})` : '';
    console.log(`  ${flag.padEnd(20)}${v.description || ''}${suffix}`);
  }
}

function summarizeRequirements(cmd) {
  const requirements = [];
  const options = cmd.options || {};
  const required = Object.entries(options)
    .filter(([, config]) => config.required)
    .map(([name]) => `--${name}`);
  if (required.length > 0) requirements.push(`in: ${required.join(' ')}`);
  if (cmd.output) requirements.push(`out: ${cmd.output}`);
  return requirements.length > 0 ? ` [${requirements.join(' | ')}]` : '';
}

function printHelp() {
  console.log('Usage: tv <command> [options]\n');
  console.log('Global options:');
  console.log('      --format <markdown|json>  Output mode for all commands (default: markdown)');
  console.log('');
  console.log('Commands:');
  const labels = [];
  for (const [name, cmd] of commands) {
    labels.push(name);
    if (cmd.subcommands) {
      for (const [subName] of cmd.subcommands) {
        labels.push(`${name} ${subName}`);
      }
    }
  }
  const maxLen = Math.max(...labels.map(label => label.length));
  for (const [name, cmd] of commands) {
    if (cmd.subcommands) {
      const subs = [...cmd.subcommands.keys()].join(', ');
      console.log(`  ${name.padEnd(maxLen + 2)}${cmd.description}  [${subs}]`);
      for (const [subName, subCmd] of cmd.subcommands) {
        console.log(`  ${`${name} ${subName}`.padEnd(maxLen + 2)}${subCmd.description}${summarizeRequirements(subCmd)}`);
      }
    } else {
      console.log(`  ${name.padEnd(maxLen + 2)}${cmd.description}${summarizeRequirements(cmd)}`);
    }
  }
  console.log('\nRun "tv <command> --help" for command-specific options.');
  console.log('\nDISCLAIMER');
  console.log('  Not affiliated with TradingView Inc. or Anthropic, PBC.');
  console.log('  Use subject to TradingView\'s Terms of Use: tradingview.com/policies');
}

function printCommandHelp(name, cmd) {
  if (cmd.subcommands) {
    console.log(`Usage: tv ${name} <subcommand> [options]\n`);
    console.log('Subcommands:');
    for (const [sub, subConf] of cmd.subcommands) {
      console.log(`  ${sub.padEnd(12)}${subConf.description}`);
    }
  } else {
    console.log(`Usage: tv ${name} [options]\n`);
    console.log(cmd.description);
  }
  if (cmd.details) console.log(`\n${cmd.details}`);
  console.log('\nGlobal options:');
  console.log('      --format <markdown|json>  Output mode (default: markdown)');
  printOptions(cmd.options || {});
}

function parseGlobalOptions(inputArgs) {
  const args = [];
  let format = 'markdown';

  for (let index = 0; index < inputArgs.length; index += 1) {
    const value = inputArgs[index];
    if (value === '--format') {
      const next = inputArgs[index + 1];
      if (!next) throw new Error('Missing value for --format. Use "markdown" or "json".');
      format = next;
      index += 1;
      continue;
    }
    if (value.startsWith('--format=')) {
      format = value.slice('--format='.length);
      continue;
    }
    args.push(value);
  }

  if (!['markdown', 'json'].includes(format)) {
    throw new Error(`Invalid --format value "${format}". Use "markdown" or "json".`);
  }

  return { args, format };
}

export async function run(argv) {
  let parsed;
  try {
    parsed = parseGlobalOptions(argv.slice(2));
  } catch (err) {
    handleError(err, 'json');
    return;
  }
  const { args, format } = parsed;

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    process.exit(0);
  }

  const cmdName = args[0];
  const cmd = commands.get(cmdName);

  if (!cmd) {
    console.error(`Unknown command: ${cmdName}`);
    console.error('Run "tv --help" for a list of commands.');
    process.exit(1);
  }

  // Handle subcommands (e.g., tv pine get)
  let handler, options;
  if (cmd.subcommands) {
    const subName = args[1];
    if (!subName || subName === '--help' || subName === '-h') {
      printCommandHelp(cmdName, cmd);
      process.exit(0);
    }
    const sub = cmd.subcommands.get(subName);
    if (!sub) {
      console.error(`Unknown subcommand: ${cmdName} ${subName}`);
      printCommandHelp(cmdName, cmd);
      process.exit(1);
    }
    handler = sub.handler;
    options = sub.options || {};
    // Parse remaining args after command + subcommand
    try {
      const { values, positionals } = parseArgs({
        args: args.slice(2),
        options: { help: { type: 'boolean', short: 'h' }, ...parseArgsOptions(options) },
        allowPositionals: true,
        strict: false,
      });
      if (values.help) {
        console.log(`Usage: tv ${cmdName} ${subName} [options]\n`);
        console.log(sub.description);
        if (sub.details) console.log(`\n${sub.details}`);
        printOptions(options);
        process.exit(0);
      }
      await execute(handler, values, positionals, format);
    } catch (err) {
      handleError(err, format);
    }
  } else {
    handler = cmd.handler;
    options = cmd.options || {};
    try {
      const { values, positionals } = parseArgs({
        args: args.slice(1),
        options: { help: { type: 'boolean', short: 'h' }, ...parseArgsOptions(options) },
        allowPositionals: true,
        strict: false,
      });
      if (values.help) {
        printCommandHelp(cmdName, cmd);
        process.exit(0);
      }
      await execute(handler, values, positionals, format);
    } catch (err) {
      handleError(err, format);
    }
  }
}

async function execute(handler, values, positionals, format) {
  try {
    const result = await handler(values, positionals);
    if (format === 'json') {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(toContextText(result));
    }
    process.exit(0);
  } catch (err) {
    handleError(err, format);
  }
}

function handleError(err, format = 'json') {
  const message = err.message || String(err);
  // Connection failures get exit code 2
  if (/CDP|connection|ECONNREFUSED|not running/i.test(message)) {
    if (format === 'json') {
      console.error(JSON.stringify({ success: false, error: message }, null, 2));
    } else {
      console.error(message);
    }
    process.exit(2);
  }
  if (format === 'json') {
    console.error(JSON.stringify({ success: false, error: message }, null, 2));
  } else {
    console.error(message);
  }
  process.exit(1);
}
