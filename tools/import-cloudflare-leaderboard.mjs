#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function usage() {
  return [
    'Import the local Tiny Strike leaderboard into a new Cloudflare deployment.',
    '',
    'Usage:',
    '  TINY_STRIKE_WORKER_URL=https://... TINY_STRIKE_ADMIN_TOKEN=... npm run import:leaderboard',
    '  npm run import:leaderboard -- /absolute/path/to/leaderboard.json',
    '',
    'The import is one-time and is rejected after any production player exists.',
    'Set the Worker secret first with: npx wrangler secret put ADMIN_TOKEN',
    '',
  ].join('\n');
}

function workerUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('TINY_STRIKE_WORKER_URL must be an HTTPS URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('TINY_STRIKE_WORKER_URL must be an HTTPS URL without credentials, query, or fragment.');
  }
  return url.href.replace(/\/+$/, '');
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(usage());
    return;
  }
  const service = workerUrl(process.env.TINY_STRIKE_WORKER_URL || '');
  const adminToken = String(process.env.TINY_STRIKE_ADMIN_TOKEN || '').trim();
  if (adminToken.length < 24) throw new Error('TINY_STRIKE_ADMIN_TOKEN is missing or too short.');
  const source = path.resolve(process.argv[2] || path.join(ROOT, '.tiny-strike', 'leaderboard.json'));
  const body = await readFile(source);
  if (body.byteLength > 8 * 1024 * 1024) throw new Error('Leaderboard export exceeds the 8 MiB import limit.');
  JSON.parse(body.toString('utf8'));

  const response = await fetch(`${service}/api/admin/import`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    },
    body,
  });
  const text = await response.text();
  let result;
  try { result = JSON.parse(text); } catch { result = { error: text || `HTTP ${response.status}` }; }
  if (!response.ok) throw new Error(result.error || `Import failed with HTTP ${response.status}.`);
  process.stdout.write(
    `Imported ${result.counts.players} players and ${result.counts.matches} matches into ${result.season}.\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`Leaderboard import failed: ${error.message}\n`);
  process.exitCode = 1;
});
