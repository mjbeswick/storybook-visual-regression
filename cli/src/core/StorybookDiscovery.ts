import fs from 'node:fs';
import path from 'node:path';
import { type RuntimeConfig } from '../config.js';
import chalk from 'chalk';
import { logger } from '../logger.js';

export type StoryIndexEntry = {
  id: string;
  title: string;
  name: string;
  parameters?: {
    viewport?: {
      defaultViewport?: string;
    };
  };
  globals?: {
    viewport?: {
      value?: string;
    };
  };
};

export type DiscoveredStory = StoryIndexEntry & {
  url: string;
  snapshotRelPath: string;
};

const sanitizeSegment = (segment: string): string =>
  segment
    .replace(/[\\/:*?"<>|]/g, chalk.cyan('⁄'))
    .replace(/\s+/g, ' ')
    .trim();

const toSnapshotPath = (entry: StoryIndexEntry): string => {
  // Split story ID at double dash to get directory and filename parts
  const idParts = entry.id.split('--');

  if (idParts.length >= 2) {
    // First part (before --) becomes directory name, keep as-is (or split by hyphens for nested folders)
    const dirPart = idParts[0];
    // Option 1: Keep as single directory name
    // const dirName = sanitizeSegment(dirPart);
    // Option 2: Split by hyphens for nested directories (e.g., screens-attendedcashinput -> screens/attendedcashinput)
    const dirSegments = dirPart.split('-').filter(Boolean).map(sanitizeSegment);

    // Last part (after --) becomes filename
    const filenamePart = idParts[idParts.length - 1];
    const filename = sanitizeSegment(filenamePart);

    // Join directory segments and append filename with extension
    return dirSegments.length > 0
      ? path.join(...dirSegments, filename) + '.png'
      : filename + '.png';
  }

  // Fallback to original behavior if no double dash found
  const parts = [entry.title, entry.name].map(sanitizeSegment).filter(Boolean);
  return path.join(...parts) + '.png';
};

const readJsonSafe = (filePath: string): unknown | undefined => {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * Converts a glob pattern to a regex pattern.
 * Supports: *, ?, [chars], and basic escaping.
 */
const globToRegex = (pattern: string): RegExp => {
  // Use placeholders for glob characters to avoid double-escaping
  const PLACEHOLDER_STAR = '\u0001';
  const PLACEHOLDER_QUESTION = '\u0002';
  const PLACEHOLDER_BRACKET_OPEN = '\u0003';
  const PLACEHOLDER_BRACKET_CLOSE = '\u0004';

  const regex = pattern
    // Replace glob characters with placeholders
    .replace(/\*/g, PLACEHOLDER_STAR)
    .replace(/\?/g, PLACEHOLDER_QUESTION)
    .replace(/\[/g, PLACEHOLDER_BRACKET_OPEN)
    .replace(/\]/g, PLACEHOLDER_BRACKET_CLOSE)
    // Escape all regex special characters
    .replace(/[.+^${}()|\\]/g, '\\$&')
    // Replace placeholders with regex equivalents
    .replace(new RegExp(PLACEHOLDER_STAR, 'g'), '.*')
    .replace(new RegExp(PLACEHOLDER_QUESTION, 'g'), '.')
    .replace(new RegExp(PLACEHOLDER_BRACKET_OPEN, 'g'), '[')
    .replace(new RegExp(PLACEHOLDER_BRACKET_CLOSE, 'g'), ']');

  // Match anywhere in the string (not anchored to start/end)
  return new RegExp(regex, 'i');
};

/**
 * Tests if a string matches a glob pattern.
 * Falls back to substring matching for patterns without glob characters.
 */
const matchesGlob = (str: string, pattern: string): boolean => {
  const lowerPattern = pattern.toLowerCase();
  const lowerStr = str.toLowerCase();

  // If pattern contains glob characters, use regex matching
  if (lowerPattern.includes('*') || lowerPattern.includes('?') || lowerPattern.includes('[')) {
    try {
      const regex = globToRegex(lowerPattern);
      return regex.test(lowerStr);
    } catch {
      // If regex conversion fails, fall back to substring
      return lowerStr.includes(lowerPattern);
    }
  }

  // Otherwise use substring matching for backward compatibility
  return lowerStr.includes(lowerPattern);
};

export const discoverStories = async (config: RuntimeConfig): Promise<DiscoveredStory[]> => {
  logger.debug('Starting story discovery process');

  // Use original URL for display purposes (shows localhost instead of host.docker.internal)
  const displayUrl = config.originalUrl || config.url;
  logger.debug(`Storybook URL: ${displayUrl}`);

  // Extract port from display URL for troubleshooting
  const urlObj = new URL(displayUrl);
  const port = urlObj.port || (urlObj.protocol === 'https:' ? '443' : '80');

  // Prefer running server index.json; fallback to static
  logger.debug('Preparing candidate locations for story index');
  const candidates = [
    new URL('index.json', config.url).toString(),
    new URL('stories.json', config.url).toString(),
    config.resolvePath('storybook-static/index.json'),
    config.resolvePath('storybook-static/stories.json'),
  ];

  // Create display versions of the HTTP candidates for error messages
  const displayCandidates = [
    new URL('index.json', displayUrl).toString(),
    new URL('stories.json', displayUrl).toString(),
    config.resolvePath('storybook-static/index.json'),
    config.resolvePath('storybook-static/stories.json'),
  ];

  let indexData: any;
  const attemptedUrls: string[] = [];
  const errors: string[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const displayCandidate = displayCandidates[i];

    if (candidate.startsWith('http')) {
      attemptedUrls.push(displayCandidate); // Use display URL in error messages
      logger.debug(`Attempting to fetch story index from: ${displayCandidate}`);
      try {
        const res = await fetch(candidate, {
          signal: AbortSignal.timeout(10000), // 10 second timeout
        });
        if (res.ok) {
          indexData = await res.json();
          logger.debug(`Successfully loaded story index from: ${displayCandidate}`);
          break;
        } else {
          const errorMsg = `HTTP ${res.status} ${res.statusText}`;
          errors.push(`${displayCandidate}: ${errorMsg}`);
          logger.debug(`${displayCandidate} -> ${errorMsg}`);
        }
      } catch (e) {
        const errorMsg = (e as Error).message;
        errors.push(`${displayCandidate}: ${errorMsg}`);
        logger.debug(`Failed to fetch ${displayCandidate}: ${errorMsg}`);
      }
    } else {
      logger.debug(`Attempting to load static story index from: ${displayCandidate}`);
      const data = readJsonSafe(candidate);
      if (data) {
        indexData = data;
        logger.debug(`Successfully loaded story index from static file: ${displayCandidate}`);
        break;
      } else {
        errors.push(`${displayCandidate}: File not found or invalid JSON`);
        logger.debug(`Failed to load static file: ${displayCandidate}`);
      }
    }
  }

  if (!indexData) {
    logger.error('Failed to load story index from any candidate location');
    // Check if we're likely running in Docker
    const isLikelyDocker =
      process.env.DOCKER_CONTAINER === 'true' ||
      fs.existsSync('/.dockerenv') ||
      (process.env.HOSTNAME && process.env.HOSTNAME.includes('docker'));

    const errorMsg = [
      'Could not load Storybook index.json from server or static files.',
      '',
      'Attempted locations:',
      ...attemptedUrls.map((url) => `  • ${url}`),
      ...candidates.filter((c) => !c.startsWith('http')).map((file) => `  • ${file} (static file)`),
      '',
      'Common issues:',
      '  • Storybook server is not running or accessible',
      isLikelyDocker
        ? '  • When running in Docker, use host.docker.internal instead of localhost'
        : '  • Wrong URL or port (check that Storybook is running)',
      '  • Storybook static build not found in expected location',
      '  • Network connectivity or firewall issues',
      '',
      'Troubleshooting steps:',
      isLikelyDocker
        ? `  • Use --url http://host.docker.internal:${port} (or check that Storybook is running on host.docker.internal:${port})`
        : `  • Check that Storybook is running: curl http://localhost:${port}`,
      '  • Verify Storybook index.json is accessible',
      '  • Try with --debug flag for more detailed output',
      '',
      'Recent errors:',
      ...errors.slice(-3).map((err) => `  • ${err}`), // Show last 3 errors
    ].join('\n');

    throw new Error(errorMsg);
  }

  const source = ((): any[] => {
    if (indexData && typeof indexData === 'object') {
      // Storybook 6/7 style: { stories: { [id]: { id, title, name } } }
      if (indexData.stories && typeof indexData.stories === 'object')
        return Object.values(indexData.stories as any);
      // Some builds may expose { entries: { [id]: { id, title, name } } }
      if (indexData.entries && typeof indexData.entries === 'object')
        return Object.values(indexData.entries as any);
      // Already an array?
      if (Array.isArray(indexData)) return indexData as any[];
    }
    return [];
  })();

  logger.debug(`Processing ${source.length} raw story entries from index`);
  const stories: StoryIndexEntry[] = source
    .map((s: any) => {
      const story = {
        id: String(s.id ?? s.sid ?? ''),
        title: String(s.title ?? s.kind ?? ''),
        name: String(s.name ?? s.story ?? ''),
        parameters: s.parameters,
        globals: s.globals,
      };

      // Debug logging for stories with viewport globals
      if (s.globals?.viewport || s.parameters?.viewport) {
        logger.debug(
          `Story ${story.id}: Found viewport config - globals.viewport: ${JSON.stringify(s.globals?.viewport)}, parameters.viewport: ${JSON.stringify(s.parameters?.viewport)}`,
        );
      }

      // Debug logging for attended stories to see what's actually in index.json
      if (story.id.includes('attended') || story.title.toLowerCase().includes('attended')) {
        logger.debug(
          `Story ${story.id}: Raw data from index.json - hasGlobals: ${!!s.globals}, globals: ${JSON.stringify(s.globals)}, hasParameters: ${!!s.parameters}, parameters.viewport: ${JSON.stringify(s.parameters?.viewport)}`,
        );
      }

      return story;
    })
    .filter((s) => s.id && s.title && s.name);
  logger.debug(`Parsed ${stories.length} valid story entries`);

  const filtered = stories.filter((s) => {
    const hay = `${s.id} ${s.title} ${s.name}`.toLowerCase();
    if (config.grep) {
      try {
        const re = new RegExp(config.grep);
        if (!re.test(s.id)) return false;
      } catch {
        // invalid regex -> ignore
      }
    }
    const includes = config.includeStories;
    const excludes = config.excludeStories;
    const match = (patterns?: string[]): boolean => {
      if (!patterns) return true;
      return patterns.some((p) => matchesGlob(hay, p));
    };
    if (includes && !match(includes)) return false;
    if (excludes && match(excludes)) return false;
    return true;
  });

  const mapped: DiscoveredStory[] = filtered.map((s) => ({
    ...s,
    // Use manager URL format: /?path=/story/story-id
    // This allows us to access the manager API and screenshot the iframe
    url: new URL(`/?path=/story/${encodeURIComponent(s.id)}`, config.url).toString(),
    snapshotRelPath: toSnapshotPath(s),
  }));

  logger.info(
    `Discovered ${mapped.length} stories (${stories.length} total, ${stories.length - mapped.length} filtered out)`,
  );
  logger.debug(`Story filtering: total=${stories.length}, after filters=${mapped.length}`);

  return mapped;
};
