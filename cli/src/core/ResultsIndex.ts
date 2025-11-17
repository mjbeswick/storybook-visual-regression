import fs from 'node:fs';
import path from 'node:path';

export type ResultEntry = {
  storyId: string;
  snapshotId: string;
  browser?: string;
  viewportName?: string;
  status: 'passed' | 'failed' | 'new' | 'missing';
  diffPixels?: number;
  diffPercent?: number;
  duration?: number;
  createdAt: string; // ISO date string
  updatedAt: string; // ISO date string
};

export type ResultsIndex = {
  version: number;
  entries: ResultEntry[];
};

/**
 * Thread-safe results index manager
 * Tracks test results separately from snapshots
 * All JSON updates are queued and processed in the main thread
 */
export class ResultsIndexManager {
  private indexPath: string;
  private index: ResultsIndex;
  private entriesMap: Map<string, ResultEntry> = new Map(); // Internal map for O(1) lookups
  private pendingUpdates: Map<string, ResultEntry> = new Map();
  private isWriting = false;
  private writeTimer: NodeJS.Timeout | null = null;
  private readonly WRITE_DEBOUNCE_MS = 5000; // Batch writes for 5 seconds
  private readonly MAX_PENDING_BEFORE_WRITE = 50; // Force write after 50 pending updates

  constructor(resultsDir: string) {
    // Store index.json in the results directory (migrate from old results.json if needed)
    const indexJsonPath = path.join(resultsDir, 'index.json');
    const resultsJsonPath = path.join(resultsDir, 'results.json');

    // Migrate from old results.json to new index.json if needed
    if (fs.existsSync(resultsJsonPath) && !fs.existsSync(indexJsonPath)) {
      try {
        fs.copyFileSync(resultsJsonPath, indexJsonPath);
        // Optionally remove old file after successful migration
        // fs.unlinkSync(resultsJsonPath);
      } catch (error) {
        console.warn(`Failed to migrate results.json to index.json: ${error}`);
      }
    }

    this.indexPath = indexJsonPath;
    this.index = this.loadIndex();
    this.buildEntriesMap();
  }

  private buildEntriesMap(): void {
    this.entriesMap.clear();
    for (const entry of this.index.entries) {
      const key = this.buildKey(entry.storyId, entry.browser, entry.viewportName);
      this.entriesMap.set(key, entry);
    }
  }

  /**
   * Build a unique key for a result entry
   */
  private buildKey(storyId: string, browser?: string, viewportName?: string): string {
    const parts = [storyId];
    if (browser) parts.push(`browser:${browser}`);
    if (viewportName) parts.push(`viewport:${viewportName}`);
    return parts.join('::');
  }

  private loadIndex(): ResultsIndex {
    if (fs.existsSync(this.indexPath)) {
      try {
        const content = fs.readFileSync(this.indexPath, 'utf8');
        const parsed = JSON.parse(content);

        // Migrate old format (object with keys) to new format (array)
        if (parsed.entries && !Array.isArray(parsed.entries)) {
          const oldEntries = parsed.entries as Record<string, ResultEntry>;
          parsed.entries = Object.values(oldEntries);
        }

        if (!parsed.version) {
          parsed.version = 1;
        }

        if (!Array.isArray(parsed.entries)) {
          parsed.entries = [];
        }

        return parsed as ResultsIndex;
      } catch (error) {
        // If index is corrupted, start fresh
        console.warn(`Failed to load index.json: ${error}, starting fresh`);
      }
    }
    return { version: 1, entries: [] };
  }

  /**
   * Sanitize a path segment to be safe for use as a directory name
   */
  private sanitizePathSegment(segment: string): string {
    return segment
      .replace(/[<>:"|?*\\/]/g, '-')
      .replace(/\s+/g, '-')
      .replace(/\.\./g, '-')
      .replace(/^[\s.-]+|[\s.-]+$/g, '')
      .replace(/-+/g, '-')
      .trim();
  }

  /**
   * Get directory path for a story ID based on the actual story path structure
   * Uses the path part of the storyId (before "--") and splits by hyphens to create nested directories
   * Browser information is stored in the index but not used in directory structure (files are GUIDs)
   * Uses the same logic as snapshot index to ensure results are in the same directory
   * e.g., "screens-basket-attended--empty" -> "screens/basket/attended"
   */
  private getDirectoryPath(storyId: string): string {
    // Extract path part from storyId (before "--")
    // e.g., "screens-basket-attended--empty" -> "screens-basket-attended"
    const pathPart = storyId.split('--')[0];

    // Split by hyphens and sanitize each segment
    const dirSegments = pathPart
      .split('-')
      .filter(Boolean)
      .map((seg) => this.sanitizePathSegment(seg));

    // Join segments with path separator to create nested directory structure
    // If no segments, return empty string (results go in root)
    return dirSegments.length > 0 ? path.join(...dirSegments) : '';
  }

  /**
   * Get directory path from snapshotId by looking up the corresponding storyId
   */
  private getDirectoryPathFromSnapshotId(snapshotId: string): string {
    // Find the entry with this snapshotId - check entriesMap first (most up-to-date)
    for (const entry of this.entriesMap.values()) {
      if (entry.snapshotId === snapshotId) {
        return this.getDirectoryPath(entry.storyId);
      }
    }
    // Fallback: check index.entries (for entries loaded from disk)
    const entry = this.index.entries.find((e) => e.snapshotId === snapshotId);
    if (entry) {
      return this.getDirectoryPath(entry.storyId);
    }
    // This should never happen if setResult() is called first
    // But if it does, return empty string to put file in root rather than creating hash directories
    return '';
  }

  /**
   * Get result path matching snapshot structure
   * Results are stored in the same directory as their corresponding snapshots
   * Directory is based on the path part of the storyId (before "--"), split by hyphens
   * @param snapshotId - The snapshot ID
   * @param basePath - The base path for results
   * @param type - The type of result file ('actual' or 'diff')
   * @param storyId - Optional storyId to avoid lookup (should be provided when available)
   */
  getResultPath(
    snapshotId: string,
    basePath: string,
    type: 'actual' | 'diff',
    storyId?: string,
  ): string {
    const dir = storyId
      ? this.getDirectoryPath(storyId)
      : this.getDirectoryPathFromSnapshotId(snapshotId);
    const ext = type === 'diff' ? '.diff.png' : '.png';
    // If dir is empty, put file directly in basePath
    return dir
      ? path.join(basePath, dir, `${snapshotId}${ext}`)
      : path.join(basePath, `${snapshotId}${ext}`);
  }

  /**
   * Add or update a result entry
   */
  setResult(
    storyId: string,
    snapshotId: string,
    status: 'passed' | 'failed' | 'new' | 'missing',
    options?: {
      browser?: string;
      viewportName?: string;
      diffPixels?: number;
      diffPercent?: number;
      duration?: number;
    },
  ): void {
    const key = this.buildKey(storyId, options?.browser, options?.viewportName);
    const now = new Date().toISOString();

    const existingEntry = this.entriesMap.get(key);
    const resultEntry: ResultEntry = {
      storyId,
      snapshotId,
      browser: options?.browser,
      viewportName: options?.viewportName,
      status,
      ...(options?.diffPixels !== undefined &&
        options.diffPixels !== 0 && { diffPixels: options.diffPixels }),
      ...(options?.diffPercent !== undefined &&
        options.diffPercent !== 0 && { diffPercent: options.diffPercent }),
      duration: options?.duration,
      createdAt: existingEntry?.createdAt ?? now,
      updatedAt: now,
    };

    if (existingEntry) {
      // Update existing entry in array
      const index = this.index.entries.indexOf(existingEntry);
      if (index !== -1) {
        this.index.entries[index] = resultEntry;
      }
    } else {
      // New entry - add to array
      this.index.entries.push(resultEntry);
    }

    this.entriesMap.set(key, resultEntry);
    this.pendingUpdates.set(key, resultEntry);
    this.scheduleWrite();
  }

  /**
   * Get result entry by story ID
   */
  getResult(storyId: string, browser?: string, viewportName?: string): ResultEntry | undefined {
    const key = this.buildKey(storyId, browser, viewportName);
    return this.entriesMap.get(key);
  }

  /**
   * Get all entries for a story (across all viewports)
   */
  getResultsForStory(storyId: string): ResultEntry[] {
    return this.index.entries.filter((entry) => entry.storyId === storyId);
  }

  /**
   * Get all entries (for reporting)
   */
  getAllEntries(): ResultEntry[] {
    return [...this.index.entries];
  }

  /**
   * Schedule a write operation (thread-safe, queues writes)
   * Uses debouncing to batch multiple updates together
   */
  private scheduleWrite(): void {
    if (this.isWriting) {
      return; // Write already in progress
    }

    // If we have too many pending updates, write immediately
    if (this.pendingUpdates.size >= this.MAX_PENDING_BEFORE_WRITE) {
      if (this.writeTimer) {
        clearTimeout(this.writeTimer);
        this.writeTimer = null;
      }
      setImmediate(() => {
        this.flushWrites();
      });
      return;
    }

    // Debounce writes - wait for more updates before writing
    if (this.writeTimer) {
      return; // Write already scheduled
    }

    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.flushWrites();
    }, this.WRITE_DEBOUNCE_MS);
  }

  /**
   * Flush pending writes to disk
   */
  private flushWrites(): void {
    if (this.pendingUpdates.size === 0) {
      this.isWriting = false;
      return;
    }

    this.isWriting = true;

    try {
      // Updates are already applied to index.entries and entriesMap in setResult()
      // Just need to write to disk

      // Write to disk atomically
      const tempPath = `${this.indexPath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(this.index, null, 2), 'utf8');
      fs.renameSync(tempPath, this.indexPath);

      this.pendingUpdates.clear();
    } catch (error) {
      console.error(`Failed to write index.json: ${error}`);
    } finally {
      this.isWriting = false;

      // If more updates came in while writing, schedule another write
      if (this.pendingUpdates.size > 0) {
        this.scheduleWrite();
      }
    }
  }

  /**
   * Force flush all pending writes (call before exit)
   */
  flush(): void {
    // Clear any pending timer and write immediately
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }

    while (this.pendingUpdates.size > 0 || this.isWriting) {
      this.flushWrites();
      // Small delay to allow async operations to complete
      if (this.pendingUpdates.size > 0) {
        const start = Date.now();
        while (Date.now() - start < 100 && this.pendingUpdates.size > 0) {
          // Busy wait
        }
      }
    }
  }

  /**
   * Clean up entries that no longer have corresponding result files
   * Also removes entries for passed tests since we don't write files for passed tests anymore
   */
  cleanupOrphanedEntries(resultsBasePath: string): void {
    const orphanedEntries: ResultEntry[] = [];

    for (const entry of this.index.entries) {
      // Remove entries for passed tests since we don't write files for them
      if (entry.status === 'passed') {
        orphanedEntries.push(entry);
        continue;
      }

      const actualPath = this.getResultPath(entry.snapshotId, resultsBasePath, 'actual');
      const diffPath = this.getResultPath(entry.snapshotId, resultsBasePath, 'diff');

      // If both files don't exist, remove the entry
      if (!fs.existsSync(actualPath) && !fs.existsSync(diffPath)) {
        orphanedEntries.push(entry);
      }
    }

    if (orphanedEntries.length > 0) {
      // Remove from array
      this.index.entries = this.index.entries.filter((entry) => !orphanedEntries.includes(entry));

      // Remove from map
      for (const entry of orphanedEntries) {
        const key = this.buildKey(entry.storyId, entry.browser, entry.viewportName);
        this.entriesMap.delete(key);
      }

      this.scheduleWrite();
    }
  }

  /**
   * Clean up result files that don't have corresponding entries in the index
   * This ensures the directory structure matches index.json
   */
  cleanupOrphanedFiles(resultsBasePath: string): {
    deletedFiles: number;
    deletedDirectories: number;
  } {
    let deletedFiles = 0;
    const deletedDirs = new Set<string>();

    if (!fs.existsSync(resultsBasePath)) {
      return { deletedFiles: 0, deletedDirectories: 0 };
    }

    // Create a set of snapshotIds that have entries in the index
    const validSnapshotIds = new Set(this.index.entries.map((e) => e.snapshotId));

    // Walk the results directory and find orphaned files
    const walkAndClean = (dirPath: string): void => {
      try {
        if (!fs.existsSync(dirPath)) {
          return;
        }

        const entries = fs.readdirSync(dirPath);
        let dirIsEmpty = true;

        for (const name of entries) {
          const fullPath = path.join(dirPath, name);
          const stat = fs.statSync(fullPath);

          if (stat.isDirectory()) {
            walkAndClean(fullPath);
            // Check again after cleaning subdirectory
            if (fs.existsSync(fullPath) && fs.readdirSync(fullPath).length === 0) {
              try {
                fs.rmdirSync(fullPath);
                deletedDirs.add(fullPath);
              } catch (error) {
                // Ignore errors
              }
            } else {
              dirIsEmpty = false;
            }
          } else if (name.endsWith('.png') || name.endsWith('.diff.png')) {
            // Extract snapshotId from filename (remove .png or .diff.png extension)
            const snapshotId = name.replace(/\.diff\.png$/, '').replace(/\.png$/, '');

            // Check if this file belongs to a valid entry
            if (!validSnapshotIds.has(snapshotId)) {
              try {
                fs.unlinkSync(fullPath);
                deletedFiles++;
              } catch (error) {
                // Ignore errors (file might already be deleted, permissions, etc.)
              }
            } else {
              dirIsEmpty = false;
            }
          } else {
            // Keep other files (like index.json, etc.)
            dirIsEmpty = false;
          }
        }

        // If directory is empty after cleanup, mark it for deletion
        if (dirIsEmpty && dirPath !== resultsBasePath) {
          try {
            if (fs.existsSync(dirPath) && fs.readdirSync(dirPath).length === 0) {
              fs.rmdirSync(dirPath);
              deletedDirs.add(dirPath);
            }
          } catch (error) {
            // Ignore errors
          }
        }
      } catch (error) {
        // Ignore errors (permissions, etc.)
      }
    };

    walkAndClean(resultsBasePath);

    return { deletedFiles, deletedDirectories: deletedDirs.size };
  }

  /**
   * Clean up duplicate entries - storyId is the primary key
   * Keeps the most recent entry per storyId and removes older duplicates
   */
  cleanupDuplicateEntries(): {
    deletedEntries: number;
  } {
    const seen = new Map<string, ResultEntry>();
    const duplicates: ResultEntry[] = [];

    for (const entry of this.index.entries) {
      const storyId = entry.storyId;
      const existing = seen.get(storyId);

      if (existing) {
        // Compare timestamps to keep the most recent one
        const existingTime = new Date(existing.updatedAt || existing.createdAt).getTime();
        const currentTime = new Date(entry.updatedAt || entry.createdAt).getTime();

        if (currentTime > existingTime) {
          // Current entry is newer, mark existing as duplicate
          duplicates.push(existing);
          seen.set(storyId, entry);
        } else {
          // Existing entry is newer or same, mark current as duplicate
          duplicates.push(entry);
        }
      } else {
        seen.set(storyId, entry);
      }
    }

    if (duplicates.length > 0) {
      // Remove duplicates from array
      this.index.entries = this.index.entries.filter((entry) => !duplicates.includes(entry));

      // Remove from map (using all possible keys)
      for (const entry of duplicates) {
        const key = this.buildKey(entry.storyId, entry.browser, entry.viewportName);
        this.entriesMap.delete(key);
      }

      // Rebuild entries map to ensure consistency
      this.buildEntriesMap();
      this.scheduleWrite();
    }

    return { deletedEntries: duplicates.length };
  }

  /**
   * Clean up results and entries for stories that no longer exist
   * This removes result files and index entries for storyIds that are not in the discovered set
   */
  cleanupStaleStories(
    discoveredStoryIds: Set<string>,
    resultsBasePath: string,
  ): {
    deletedResults: number;
    deletedEntries: number;
  } {
    let deletedResults = 0;
    let deletedEntries = 0;
    const entriesToDelete: ResultEntry[] = [];

    // Find entries for stories that no longer exist
    for (const entry of this.index.entries) {
      if (!discoveredStoryIds.has(entry.storyId)) {
        entriesToDelete.push(entry);
      }
    }

    // Delete result files and remove entries
    for (const entry of entriesToDelete) {
      const actualPath = this.getResultPath(entry.snapshotId, resultsBasePath, 'actual');
      const diffPath = this.getResultPath(entry.snapshotId, resultsBasePath, 'diff');

      // Delete actual result file
      if (fs.existsSync(actualPath)) {
        try {
          fs.unlinkSync(actualPath);
          deletedResults++;
        } catch (error) {
          // Ignore errors (file might already be deleted, permissions, etc.)
        }
      }

      // Delete diff result file
      if (fs.existsSync(diffPath)) {
        try {
          fs.unlinkSync(diffPath);
          deletedResults++;
        } catch (error) {
          // Ignore errors (file might already be deleted, permissions, etc.)
        }
      }

      // Remove from map
      const key = this.buildKey(entry.storyId, entry.browser, entry.viewportName);
      this.entriesMap.delete(key);
      deletedEntries++;
    }

    // Remove from array
    if (entriesToDelete.length > 0) {
      this.index.entries = this.index.entries.filter((entry) => !entriesToDelete.includes(entry));
      this.scheduleWrite();
    }

    return { deletedResults, deletedEntries };
  }
}
