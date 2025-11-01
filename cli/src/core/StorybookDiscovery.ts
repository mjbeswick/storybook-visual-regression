import fs from 'node:fs';
import path from 'node:path';
import { type RuntimeConfig } from '../config.js';
import chalk from 'chalk';

export type StoryIndexEntry = {
  id: string;
  title: string;
  name: string;
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

export const discoverStories = async (config: RuntimeConfig): Promise<DiscoveredStory[]> => {
  // Prefer running server index.json; fallback to static
  const candidates = [
    new URL('index.json', config.url).toString(),
    new URL('stories.json', config.url).toString(),
    config.resolvePath('storybook-static/index.json'),
    config.resolvePath('storybook-static/stories.json'),
  ];

  let indexData: any;
  const attemptedUrls: string[] = [];
  const errors: string[] = [];

  for (const candidate of candidates) {
    if (candidate.startsWith('http')) {
      attemptedUrls.push(candidate);
      try {
        if (config.debug) process.stdout.write(`Discovery: GET ${candidate}\n`);
        const res = await fetch(candidate, {
          signal: AbortSignal.timeout(10000), // 10 second timeout
        });
        if (res.ok) {
          indexData = await res.json();
          if (config.debug) process.stdout.write(`Discovery: loaded ${candidate}\n`);
          break;
        } else {
          const errorMsg = `HTTP ${res.status} ${res.statusText}`;
          errors.push(`${candidate}: ${errorMsg}`);
          if (config.debug) {
            process.stdout.write(`Discovery: ${candidate} -> ${errorMsg}\n`);
          }
        }
      } catch (e) {
        const errorMsg = (e as Error).message;
        errors.push(`${candidate}: ${errorMsg}`);
        if (config.debug)
          process.stdout.write(`Discovery: failed ${candidate} -> ${errorMsg}\n`);
      }
    } else {
      const data = readJsonSafe(candidate);
      if (data) {
        indexData = data;
        if (config.debug) process.stdout.write(`Discovery: loaded ${candidate}\n`);
        break;
      } else {
        errors.push(`${candidate}: File not found or invalid JSON`);
      }
    }
  }

  if (!indexData) {
    // Check if we're likely running in Docker
    const isLikelyDocker = process.env.DOCKER_CONTAINER === 'true' ||
                          fs.existsSync('/.dockerenv') ||
                          (process.env.HOSTNAME && process.env.HOSTNAME.includes('docker'));

    const errorMsg = [
      'Could not load Storybook index.json from server or static files.',
      '',
      'Attempted locations:',
      ...attemptedUrls.map(url => `  • ${url}`),
      ...candidates.filter(c => !c.startsWith('http')).map(file => `  • ${file} (static file)`),
      '',
      'Common issues:',
      '  • Storybook server is not running or accessible',
      isLikelyDocker ? '  • When running in Docker, use host.docker.internal instead of localhost' : '  • Wrong URL or port (check that Storybook is running)',
      '  • Storybook static build not found in expected location',
      '  • Network connectivity or firewall issues',
      '',
      'Troubleshooting steps:',
      isLikelyDocker ? '  • Use --url http://host.docker.internal:9009 (replace 9009 with your Storybook port)' : '  • Check that Storybook is running: curl http://localhost:6006',
      '  • Verify Storybook index.json is accessible',
      '  • Try with --debug flag for more detailed output',
      '',
      'Recent errors:',
      ...errors.slice(-3).map(err => `  • ${err}`), // Show last 3 errors
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

  const stories: StoryIndexEntry[] = source
    .map((s: any) => ({
      id: String(s.id ?? s.sid ?? ''),
      title: String(s.title ?? s.kind ?? ''),
      name: String(s.name ?? s.story ?? ''),
    }))
    .filter((s) => s.id && s.title && s.name);

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
    const match = (patterns?: string[]): boolean =>
      !patterns || patterns.some((p) => hay.includes(p.toLowerCase()));
    if (includes && !match(includes)) return false;
    if (excludes && match(excludes)) return false;
    return true;
  });

  const mapped: DiscoveredStory[] = filtered.map((s) => ({
    ...s,
    url: new URL(`iframe.html?id=${encodeURIComponent(s.id)}`, config.url).toString(),
    snapshotRelPath: toSnapshotPath(s),
  }));

  if (config.debug) {
    process.stdout.write(
      `Discovery: total stories in index=${stories.length}, after filters=${mapped.length}\n`,
    );
  }

  return mapped;
};
