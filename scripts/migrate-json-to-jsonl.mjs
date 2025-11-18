#!/usr/bin/env node
/**
 * Migration script to convert index.json files to index.jsonl format
 * 
 * This script converts:
 * - visual-regression/snapshots/index.json -> index.jsonl
 * - visual-regression/results/index.json -> index.jsonl
 * 
 * Run this once, then delete this script.
 * 
 * Usage: node scripts/migrate-json-to-jsonl.mjs [snapshots-dir] [results-dir]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

/**
 * Build a unique key for sorting entries
 */
function buildKey(storyId, browser, viewportName) {
  const parts = [storyId];
  if (browser) parts.push(`browser:${browser}`);
  if (viewportName) parts.push(`viewport:${viewportName}`);
  return parts.join('::');
}

/**
 * Sort entries by unique key for consistent git diffs
 */
function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    const keyA = buildKey(a.storyId, a.browser, a.viewportName);
    const keyB = buildKey(b.storyId, b.browser, b.viewportName);
    return keyA.localeCompare(keyB);
  });
}

/**
 * Migrate a JSON index file to JSONL format
 */
function migrateIndex(jsonPath, jsonlPath) {
  if (!fs.existsSync(jsonPath)) {
    console.log(`Skipping ${jsonPath} (does not exist)`);
    return false;
  }

  if (fs.existsSync(jsonlPath)) {
    console.log(`Skipping ${jsonPath} (${jsonlPath} already exists)`);
    return false;
  }

  try {
    console.log(`Migrating ${jsonPath} -> ${jsonlPath}...`);
    const content = fs.readFileSync(jsonPath, 'utf8');
    const parsed = JSON.parse(content);

    let entries = [];

    // Handle old format (object with keys)
    if (parsed.entries && !Array.isArray(parsed.entries)) {
      entries = Object.values(parsed.entries);
    } else if (Array.isArray(parsed.entries)) {
      entries = parsed.entries;
    } else {
      console.warn(`  Warning: Unexpected format in ${jsonPath}, skipping`);
      return false;
    }

    // Sort entries for consistent git diffs
    const sorted = sortEntries(entries);

    // Write as compact JSONL (one JSON object per line)
    const lines = sorted.map((entry) => JSON.stringify(entry));
    const jsonlContent = lines.join('\n') + '\n';

    // Write to disk atomically
    const tempPath = `${jsonlPath}.tmp`;
    fs.writeFileSync(tempPath, jsonlContent, 'utf8');
    fs.renameSync(tempPath, jsonlPath);

    console.log(`  ✓ Migrated ${entries.length} entries`);
    return true;
  } catch (error) {
    console.error(`  ✗ Error migrating ${jsonPath}: ${error.message}`);
    return false;
  }
}

// Main execution
const snapshotsDir = process.argv[2] || path.join(projectRoot, 'visual-regression', 'snapshots');
const resultsDir = process.argv[3] || path.join(projectRoot, 'visual-regression', 'results');

console.log('Migrating index files from JSON to JSONL format...\n');

const snapshotsJson = path.join(snapshotsDir, 'index.json');
const snapshotsJsonl = path.join(snapshotsDir, 'index.jsonl');
const resultsJson = path.join(resultsDir, 'index.json');
const resultsJsonl = path.join(resultsDir, 'index.jsonl');

let migrated = 0;

if (migrateIndex(snapshotsJson, snapshotsJsonl)) {
  migrated++;
}

if (migrateIndex(resultsJson, resultsJsonl)) {
  migrated++;
}

console.log(`\nMigration complete. ${migrated} file(s) migrated.`);
console.log('You can now delete this script and remove the old index.json files if desired.');


