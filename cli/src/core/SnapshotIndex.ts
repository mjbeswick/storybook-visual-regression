import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export type SnapshotEntry = {
  storyId: string;
  snapshotId: string;
  browser?: string;
  viewportName?: string;
  viewport?: { width: number; height: number };
  createdAt: string; // ISO date string
  updatedAt: string; // ISO date string
};

export type SnapshotIndex = {
  version: number;
  entries: SnapshotEntry[];
};

/**
 * Thread-safe index manager for snapshots and results
 * All JSON updates are queued and processed in the main thread
 */
export class SnapshotIndexManager {
  private indexPath: string;
  private index: SnapshotIndex;
  private entriesMap: Map<string, SnapshotEntry> = new Map(); // Internal map for O(1) lookups
  private pendingUpdates: Map<string, SnapshotEntry> = new Map();
  private writeQueue: Array<() => void> = [];
  private isWriting = false;
  private writeTimer: NodeJS.Timeout | null = null;
  private readonly WRITE_DEBOUNCE_MS = 500; // Batch writes for 500ms
  private readonly MAX_PENDING_BEFORE_WRITE = 50; // Force write after 50 pending updates
  private readonly DIRECTORY_COUNT = 256; // Used only for fallback when entry not found

  constructor(snapshotsDir: string) {
    // Store index.json in the snapshots directory
    this.indexPath = path.join(snapshotsDir, 'index.json');
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
   * Build a unique key for a snapshot entry
   */
  private buildKey(storyId: string, browser?: string, viewportName?: string): string {
    const parts = [storyId];
    if (browser) parts.push(`browser:${browser}`);
    if (viewportName) parts.push(`viewport:${viewportName}`);
    return parts.join('::');
  }

  private loadIndex(): SnapshotIndex {
    if (fs.existsSync(this.indexPath)) {
      try {
        const content = fs.readFileSync(this.indexPath, 'utf8');
        const parsed = JSON.parse(content);
        
        // Migrate old format (object with keys) to new format (array)
        if (parsed.entries && !Array.isArray(parsed.entries)) {
          // Old format: { entries: { "storyId": { storyId, snapshotId, ... } } }
          const oldEntries = parsed.entries as Record<string, SnapshotEntry>;
          parsed.entries = Object.values(oldEntries);
        }
        
        if (!parsed.version) {
          parsed.version = 1;
        }
        
        if (!Array.isArray(parsed.entries)) {
          parsed.entries = [];
        }
        
        return parsed as SnapshotIndex;
      } catch (error) {
        // If index is corrupted, start fresh
        console.warn(`Failed to load index.json: ${error}, starting fresh`);
      }
    }
    return { version: 1, entries: [] };
  }

  /**
   * Get snapshot ID for a story, creating one if it doesn't exist
   * storyId is the primary key - only one entry per storyId
   */
  getSnapshotId(storyId: string, browser?: string, viewportName?: string): string {
    // Default browser to 'chromium' if not provided
    const normalizedBrowser = browser || 'chromium';
    
    // Check if an entry already exists for this storyId (primary key)
    const existingEntry = this.index.entries.find(e => e.storyId === storyId);
    
    if (existingEntry) {
      // Update existing entry with browser and viewport name if provided
      let updated = false;
      if (normalizedBrowser && existingEntry.browser !== normalizedBrowser) {
        existingEntry.browser = normalizedBrowser;
        updated = true;
      }
      if (viewportName && existingEntry.viewportName !== viewportName) {
        existingEntry.viewportName = viewportName;
        updated = true;
      }
      
      if (updated) {
        existingEntry.updatedAt = new Date().toISOString();
        // Rebuild entries map with updated key
        this.buildEntriesMap();
        const key = this.buildKey(storyId, existingEntry.browser, existingEntry.viewportName);
        this.pendingUpdates.set(key, existingEntry);
        this.scheduleWrite();
      }
      
      return existingEntry.snapshotId;
    }

    // Create new entry
    const snapshotId = randomUUID();
    const now = new Date().toISOString();
    const newEntry: SnapshotEntry = {
      storyId,
      snapshotId,
      browser: normalizedBrowser,
      viewportName,
      createdAt: now,
      updatedAt: now,
    };

    const key = this.buildKey(storyId, normalizedBrowser, viewportName);
    this.entriesMap.set(key, newEntry);
    this.index.entries.push(newEntry);
    this.pendingUpdates.set(key, newEntry);
    this.scheduleWrite();

    return snapshotId;
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
   * This makes it easy to navigate and find snapshots by browsing the directory structure
   * e.g., "screens-basket-attended--empty" -> "screens/basket/attended"
   */
  private getDirectoryPath(storyId: string): string {
    // Extract path part from storyId (before "--")
    // e.g., "screens-basket-attended--empty" -> "screens-basket-attended"
    const pathPart = storyId.split('--')[0];
    
    // Split by hyphens and sanitize each segment
    const dirSegments = pathPart.split('-').filter(Boolean).map(seg => this.sanitizePathSegment(seg));
    
    // Join segments with path separator to create nested directory structure
    // If no segments, return empty string (snapshots go in root)
    return dirSegments.length > 0 ? path.join(...dirSegments) : '';
  }

  /**
   * Get directory path from snapshotId by looking up the corresponding storyId
   */
  private getDirectoryPathFromSnapshotId(snapshotId: string): string {
    // Find the entry with this snapshotId - check both entriesMap (most up-to-date) and index.entries
    // First check entriesMap for all entries
    for (const entry of this.entriesMap.values()) {
      if (entry.snapshotId === snapshotId) {
        return this.getDirectoryPath(entry.storyId);
      }
    }
    // Fallback: check index.entries (for entries loaded from disk)
    const entry = this.index.entries.find(e => e.snapshotId === snapshotId);
    if (entry) {
      return this.getDirectoryPath(entry.storyId);
    }
    // This should never happen if getSnapshotId() is called first
    // But if it does, return empty string to put file in root rather than creating hash directories
    return '';
  }

  /**
   * Get snapshot path organized into subdirectories based on story path structure
   * Directory is based on the path part of the storyId (before "--"), split by hyphens
   * e.g., screens-basket-attended--empty -> screens/basket/attended/326416d3-3747-4355-8a5b-99561fa70b3c.png
   * @param snapshotId - The snapshot ID
   * @param basePath - The base path for snapshots
   * @param storyId - Optional storyId to avoid lookup (should be provided when available)
   */
  getSnapshotPath(snapshotId: string, basePath: string, storyId?: string): string {
    const dir = storyId 
      ? this.getDirectoryPath(storyId)
      : this.getDirectoryPathFromSnapshotId(snapshotId);
    // If dir is empty, put file directly in basePath
    return dir ? path.join(basePath, dir, `${snapshotId}.png`) : path.join(basePath, `${snapshotId}.png`);
  }

  /**
   * Get result path matching snapshot structure
   */
  getResultPath(snapshotId: string, basePath: string, type: 'actual' | 'diff'): string {
    const dir = this.getDirectoryPathFromSnapshotId(snapshotId);
    const ext = type === 'diff' ? '.diff.png' : '.png';
    return path.join(basePath, dir, `${snapshotId}${ext}`);
  }

  /**
   * Get entry by story ID
   */
  getEntry(storyId: string, browser?: string, viewportName?: string): SnapshotEntry | undefined {
    const key = this.buildKey(storyId, browser, viewportName);
    return this.entriesMap.get(key);
  }

  /**
   * Get all entries for a story (across all viewports)
   */
  getEntriesForStory(storyId: string): SnapshotEntry[] {
    return this.index.entries.filter((entry) => entry.storyId === storyId);
  }

  /**
   * Update entry timestamp
   */
  updateEntry(storyId: string, browser?: string, viewportName?: string, viewport?: { width: number; height: number }): void {
    const key = this.buildKey(storyId, browser, viewportName);
    const entry = this.entriesMap.get(key);
    
    if (entry) {
      entry.updatedAt = new Date().toISOString();
      // Ensure browser is set if provided
      if (browser !== undefined) {
        entry.browser = browser;
      }
      if (viewportName !== undefined) {
        entry.viewportName = viewportName;
      }
      if (viewport) {
        entry.viewport = viewport;
      }
      this.pendingUpdates.set(key, entry);
      this.scheduleWrite();
    }
  }

  /**
   * Update entry by snapshotId (useful when viewport name is discovered later)
   */
  updateEntryBySnapshotId(snapshotId: string, browser?: string, viewportName?: string, viewport?: { width: number; height: number }): void {
    const entry = this.index.entries.find(e => e.snapshotId === snapshotId);
    
    if (entry) {
      entry.updatedAt = new Date().toISOString();
      // Ensure browser is set if provided
      if (browser !== undefined) {
        entry.browser = browser;
      }
      if (viewportName !== undefined) {
        entry.viewportName = viewportName;
      }
      if (viewport) {
        entry.viewport = viewport;
      }
      // Update the entries map with the new key if viewportName changed
      const oldKey = this.buildKey(entry.storyId, entry.browser, entry.viewportName);
      const newKey = this.buildKey(entry.storyId, browser || entry.browser, viewportName || entry.viewportName);
      if (oldKey !== newKey) {
        this.entriesMap.delete(oldKey);
        this.entriesMap.set(newKey, entry);
      }
      this.pendingUpdates.set(newKey, entry);
      this.scheduleWrite();
    }
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
      // Apply pending updates to both map and array
      for (const [key, entry] of this.pendingUpdates) {
        const existingEntry = this.entriesMap.get(key);
        if (existingEntry) {
          // Update existing entry in array
          const index = this.index.entries.indexOf(existingEntry);
          if (index !== -1) {
            this.index.entries[index] = entry;
          }
        } else {
          // New entry - add to array
          this.index.entries.push(entry);
        }
        this.entriesMap.set(key, entry);
      }

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
        // Synchronous wait for pending writes
        const start = Date.now();
        while (Date.now() - start < 100 && this.pendingUpdates.size > 0) {
          // Busy wait
        }
      }
    }
  }

  /**
   * Get all entries (for reporting)
   */
  getAllEntries(): SnapshotEntry[] {
    return [...this.index.entries];
  }

  /**
   * Clean up entries that no longer have corresponding snapshot files
   */
  cleanupOrphanedEntries(snapshotBasePath: string): void {
    const orphanedEntries: SnapshotEntry[] = [];

    for (const entry of this.index.entries) {
      const snapshotPath = this.getSnapshotPath(entry.snapshotId, snapshotBasePath, entry.storyId);
      if (!fs.existsSync(snapshotPath)) {
        orphanedEntries.push(entry);
      }
    }

    if (orphanedEntries.length > 0) {
      // Remove from array
      this.index.entries = this.index.entries.filter(
        (entry) => !orphanedEntries.includes(entry),
      );
      
      // Remove from map
      for (const entry of orphanedEntries) {
        const key = this.buildKey(entry.storyId, entry.browser, entry.viewportName);
        this.entriesMap.delete(key);
      }
      
      this.scheduleWrite();
    }
  }

  /**
   * Clean up snapshots and entries for stories that no longer exist
   * This removes snapshot files and index entries for storyIds that are not in the discovered set
   */
  cleanupStaleStories(discoveredStoryIds: Set<string>, snapshotBasePath: string): {
    deletedSnapshots: number;
    deletedEntries: number;
  } {
    let deletedSnapshots = 0;
    let deletedEntries = 0;
    const entriesToDelete: SnapshotEntry[] = [];

    // Find entries for stories that no longer exist
    for (const entry of this.index.entries) {
      if (!discoveredStoryIds.has(entry.storyId)) {
        entriesToDelete.push(entry);
      }
    }

    // Delete snapshot files and remove entries
    for (const entry of entriesToDelete) {
      const snapshotPath = this.getSnapshotPath(entry.snapshotId, snapshotBasePath, entry.storyId);
      if (fs.existsSync(snapshotPath)) {
        try {
          fs.unlinkSync(snapshotPath);
          deletedSnapshots++;
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
      this.index.entries = this.index.entries.filter(
        (entry) => !entriesToDelete.includes(entry),
      );
      this.scheduleWrite();
    }

    return { deletedSnapshots, deletedEntries };
  }

  /**
   * Clean up duplicate entries - storyId is the primary key
   * Keeps the most recent entry per storyId and removes older duplicates
   */
  cleanupDuplicateEntries(): {
    deletedEntries: number;
  } {
    const seen = new Map<string, SnapshotEntry>();
    const duplicates: SnapshotEntry[] = [];

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
      this.index.entries = this.index.entries.filter(
        (entry) => !duplicates.includes(entry),
      );

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

  cleanupOrphanedFiles(snapshotBasePath: string): {
    deletedFiles: number;
    deletedDirectories: number;
  } {
    let deletedFiles = 0;
    const deletedDirs = new Set<string>();
    
    // Build a set of valid snapshot IDs from the index
    const validSnapshotIds = new Set<string>();
    for (const entry of this.index.entries) {
      validSnapshotIds.add(entry.snapshotId);
    }

    // Helper to check if a directory name is a hash-based directory (two-character hex)
    const isHashDirectory = (name: string): boolean => {
      return /^[0-9a-f]{2}$/i.test(name);
    };

    // Walk the snapshots directory and find orphaned files
    const walkAndClean = (dirPath: string, relativePath: string = ''): void => {
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
            // Check if this is a "chromium" subdirectory - remove it
            if (name === 'chromium') {
              try {
                fs.rmSync(fullPath, { recursive: true, force: true });
                deletedDirs.add(fullPath);
                // Continue - don't mark dir as non-empty since we're deleting this subdir
                continue;
              } catch (error) {
                // Ignore errors
              }
            }
            
            // Check if this is a hash-based directory (two-character hex) - remove it
            if (isHashDirectory(name)) {
              try {
                fs.rmSync(fullPath, { recursive: true, force: true });
                deletedDirs.add(fullPath);
                // Continue - don't mark dir as non-empty since we're deleting this subdir
                continue;
              } catch (error) {
                // Ignore errors
              }
            }

            // Recursively clean subdirectories
            walkAndClean(fullPath, path.join(relativePath, name));
            
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
          } else if (name.endsWith('.png')) {
            // Extract snapshotId from filename (remove .png extension)
            const snapshotId = name.replace(/\.png$/, '');
            
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
          } else if (name === 'index.json') {
            // Keep index.json
            dirIsEmpty = false;
          } else {
            // Delete any other files that shouldn't be here
            try {
              fs.unlinkSync(fullPath);
              deletedFiles++;
            } catch (error) {
              // Ignore errors
            }
          }
        }

        // If directory is empty after cleanup, mark it for deletion
        if (dirIsEmpty && dirPath !== snapshotBasePath) {
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

    walkAndClean(snapshotBasePath);

    return { deletedFiles, deletedDirectories: deletedDirs.size };
  }
}

