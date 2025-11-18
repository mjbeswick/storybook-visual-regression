#!/usr/bin/env node
/**
 * Cleanup script to remove duplicate entries from index files
 * 
 * This script removes duplicate entries, keeping the most recent one per unique key.
 * 
 * Usage: node scripts/cleanup-duplicates.mjs [snapshots-dir] [results-dir]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

/**
 * Build a unique key for an entry
 */
function buildKey(storyId, browser, viewportName) {
  const parts = [storyId];
  if (browser) parts.push(`browser:${browser}`);
  if (viewportName) parts.push(`viewport:${viewportName}`);
  return parts.join('::');
}

/**
 * Cleanup duplicates in a JSONL index file
 */
function cleanupIndex(jsonlPath) {
  if (!fs.existsSync(jsonlPath)) {
    console.log(`Skipping ${jsonlPath} (does not exist)`);
    return { cleaned: false, duplicates: 0 };
  }

  try {
    console.log(`Cleaning up duplicates in ${jsonlPath}...`);
    const content = fs.readFileSync(jsonlPath, 'utf8');
    const lines = content.split('\n').filter((line) => line.trim().length > 0);
    const entries = lines.map((line) => JSON.parse(line));

    // Find duplicates, keeping the most recent one
    const seen = new Map();
    const duplicates = [];

    for (const entry of entries) {
      const key = buildKey(entry.storyId, entry.browser, entry.viewportName);
      const existing = seen.get(key);

      if (existing) {
        // Compare timestamps to keep the most recent one
        const existingTime = new Date(existing.updatedAt || existing.createdAt).getTime();
        const currentTime = new Date(entry.updatedAt || entry.createdAt).getTime();

        if (currentTime > existingTime) {
          // Current entry is newer, mark existing as duplicate
          duplicates.push(existing);
          seen.set(key, entry);
        } else {
          // Existing entry is newer or same, mark current as duplicate
          duplicates.push(entry);
        }
      } else {
        seen.set(key, entry);
      }
    }

    if (duplicates.length === 0) {
      console.log(`  ✓ No duplicates found`);
      return { cleaned: false, duplicates: 0 };
    }

    // Remove duplicates
    const uniqueEntries = entries.filter((entry) => !duplicates.includes(entry));

    // Sort entries for consistent git diffs
    const sorted = uniqueEntries.sort((a, b) => {
      const keyA = buildKey(a.storyId, a.browser, a.viewportName);
      const keyB = buildKey(b.storyId, b.browser, b.viewportName);
      return keyA.localeCompare(keyB);
    });

    // Write back as JSONL
    const jsonlLines = sorted.map((entry) => JSON.stringify(entry));
    const jsonlContent = jsonlLines.join('\n') + '\n';

    // Write atomically
    const tempPath = `${jsonlPath}.tmp`;
    fs.writeFileSync(tempPath, jsonlContent, 'utf8');
    fs.renameSync(tempPath, jsonlPath);

    console.log(`  ✓ Removed ${duplicates.length} duplicate(s), kept ${sorted.length} unique entries`);
    return { cleaned: true, duplicates: duplicates.length };
  } catch (error) {
    console.error(`  ✗ Error cleaning ${jsonlPath}: ${error.message}`);
    return { cleaned: false, duplicates: 0 };
  }
}

// Main execution
const snapshotsDir = process.argv[2] || path.join(projectRoot, 'visual-regression', 'snapshots');
const resultsDir = process.argv[3] || path.join(projectRoot, 'visual-regression', 'results');

console.log('Cleaning up duplicate entries in index files...\n');

const snapshotsJsonl = path.join(snapshotsDir, 'index.jsonl');
const resultsJsonl = path.join(resultsDir, 'index.jsonl');

let totalDuplicates = 0;

const snapshotsResult = cleanupIndex(snapshotsJsonl);
if (snapshotsResult.cleaned) {
  totalDuplicates += snapshotsResult.duplicates;
}

const resultsResult = cleanupIndex(resultsJsonl);
if (resultsResult.cleaned) {
  totalDuplicates += resultsResult.duplicates;
}

console.log(`\nCleanup complete. Removed ${totalDuplicates} duplicate entr${totalDuplicates === 1 ? 'y' : 'ies'} total.`);

