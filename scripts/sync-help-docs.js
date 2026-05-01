#!/usr/bin/env node
'use strict';

// Regenerate the auto-managed `h2v --help` block inside docs/cli.md.
//
// Usage:
//   node scripts/sync-help-docs.js          # write changes
//   node scripts/sync-help-docs.js --check  # exit 1 if doc would change
//
// The CLI's HELP_TEXT in cli.js is the canonical source. This script
// captures the live `--help` output (so it tests what users actually see)
// and replaces everything between the BEGIN/END markers in docs/cli.md.
// Anything outside the markers is left untouched.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(REPO_ROOT, 'cli.js');
const DOC_PATH = path.join(REPO_ROOT, 'docs', 'cli.md');
const BEGIN_MARKER = '<!-- BEGIN: auto-generated from `h2v --help` — do not edit by hand -->';
const END_MARKER = '<!-- END: auto-generated -->';

function captureHelp() {
  const result = spawnSync(process.execPath, [CLI_PATH, '--help'], {
    encoding: 'utf8',
  });
  if (result.error) {
    console.error(`error: failed to spawn node: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error('error: `node cli.js --help` exited non-zero.');
    if (result.stderr) console.error(result.stderr);
    process.exit(1);
  }
  // Trim a single trailing newline so the fenced block stays tight.
  return result.stdout.replace(/\n$/, '');
}

function buildBlock(helpText) {
  return `${BEGIN_MARKER}\n\`\`\`\n${helpText}\n\`\`\`\n${END_MARKER}`;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceBlock(doc, nextBlock) {
  const pattern = new RegExp(
    `${escapeRegex(BEGIN_MARKER)}[\\s\\S]*?${escapeRegex(END_MARKER)}`
  );
  if (!pattern.test(doc)) {
    console.error(`error: BEGIN/END marker block not found in ${DOC_PATH}.`);
    console.error('expected to see, on their own lines:');
    console.error(`  ${BEGIN_MARKER}`);
    console.error(`  ${END_MARKER}`);
    process.exit(1);
  }
  return doc.replace(pattern, nextBlock);
}

function main() {
  const checkMode = process.argv.includes('--check');

  const help = captureHelp();
  const doc = fs.readFileSync(DOC_PATH, 'utf8');
  const next = replaceBlock(doc, buildBlock(help));

  if (next === doc) {
    console.log('docs/cli.md is up to date.');
    return;
  }

  if (checkMode) {
    console.error('error: docs/cli.md is out of sync with `h2v --help`.');
    console.error('  run: npm run docs:sync');
    process.exit(1);
  }

  fs.writeFileSync(DOC_PATH, next);
  console.log('docs/cli.md updated from `h2v --help`.');
}

main();
