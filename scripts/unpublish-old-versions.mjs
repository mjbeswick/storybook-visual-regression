#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import process from 'node:process';

const [, , packageName, keepArg] = process.argv;

if (!packageName) {
  console.error('Usage: npm run unpublish -- <package-name> [keepCount]');
  process.exit(1);
}

const parsedKeep = keepArg ? Number.parseInt(keepArg, 10) : Number.NaN;
const keepCount = Number.isFinite(parsedKeep) && parsedKeep > 0 ? parsedKeep : 1;

let versionsRaw = '';
try {
  versionsRaw = execFileSync('npm', ['view', packageName, 'versions', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
} catch (error) {
  console.error(`Failed to fetch versions for ${packageName}`);
  if (error instanceof Error && error.message) {
    console.error(error.message);
  }
  process.exit(1);
}

let versions = [];
try {
  const parsed = JSON.parse(versionsRaw);
  versions = Array.isArray(parsed) ? parsed : [parsed];
} catch (error) {
  console.error(`Could not parse version list for ${packageName}`);
  if (error instanceof Error && error.message) {
    console.error(error.message);
  }
  process.exit(1);
}

if (versions.length === 0) {
  console.log(`No published versions found for ${packageName}.`);
  process.exit(0);
}

const keep = Math.min(keepCount, versions.length);
const toRemove = versions.slice(0, versions.length - keep);

if (toRemove.length === 0) {
  console.log(`Nothing to unpublish for ${packageName} (only ${versions.length} version(s) found).`);
  process.exit(0);
}

console.log(
  `Unpublishing ${toRemove.length} version${toRemove.length === 1 ? '' : 's'} of ${packageName}, keeping latest ${keep}.`,
);

for (const version of toRemove) {
  const spec = `${packageName}@${version}`;
  console.log(`Unpublishing ${spec}...`);
  const result = spawnSync('npm', ['unpublish', spec], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`Failed to unpublish ${spec}.`);
    process.exit(result.status ?? 1);
  }
}

console.log('Unpublish complete.');
