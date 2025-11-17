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
  snapshotId?: string; // Will be set by index manager
  snapshotRelPath?: string; // Deprecated, kept for backward compatibility
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
 * Try to detect Docker gateway IP as fallback when host.docker.internal doesn't work
 * This is useful on Linux where host.docker.internal isn't available by default
 */
const getDockerGatewayIP = (): string | null => {
  try {
    // Try to read the default gateway from /proc/net/route
    const routeContent = fs.readFileSync('/proc/net/route', 'utf8');
    const lines = routeContent.split('\n');
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts[1] === '00000000' && parts[7] === '0003') {
        // Found default gateway, convert hex IP to decimal
        const hexIP = parts[2];
        if (hexIP && hexIP.length === 8) {
          const ip = [
            parseInt(hexIP.slice(6, 8), 16),
            parseInt(hexIP.slice(4, 6), 16),
            parseInt(hexIP.slice(2, 4), 16),
            parseInt(hexIP.slice(0, 2), 16),
          ].join('.');
          return ip;
        }
      }
    }
  } catch {
    // Ignore errors - this is a fallback mechanism
  }
  return null;
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

  // Build candidates list - if host.docker.internal fails, we'll try gateway IP
  // Track the working URL so we can use it for building story URLs
  let workingUrl = config.url;
  const candidates = [
    new URL('index.json', workingUrl).toString(),
    new URL('stories.json', workingUrl).toString(),
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
      // Log both display URL (for user) and actual URL (for debugging)
      logger.debug(
        `Attempting to fetch story index from: ${displayCandidate} (actual: ${candidate})`,
      );
      attemptedUrls.push(candidate); // Use actual URL attempted in error messages for accuracy
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
          errors.push(`${candidate}: ${errorMsg}`);
          logger.debug(`${candidate} -> ${errorMsg}`);
        }
      } catch (e) {
        const err = e as Error;
        // Provide more context for common fetch errors
        let errorMsg = err.message;
        if (err.message === 'fetch failed') {
          // fetch failed usually means connection refused or network unreachable
          const url = new URL(candidate);
          if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
            errorMsg = 'fetch failed (connection refused - service may not be running)';
          } else {
            errorMsg = 'fetch failed (network unreachable or connection refused)';
          }
        }
        errors.push(`${candidate}: ${errorMsg}`);
        logger.debug(`Failed to fetch ${candidate}: ${errorMsg}`);
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

  // If localhost failed and we're in Docker, try host.docker.internal as fallback
  // (works in normal Docker networking mode, but not in --network host mode)
  if (!indexData && workingUrl.includes('localhost')) {
    const isLikelyDocker =
      process.env.DOCKER_CONTAINER === 'true' ||
      fs.existsSync('/.dockerenv') ||
      (process.env.HOSTNAME && process.env.HOSTNAME.includes('docker')) ||
      process.env.DOCKER_BUILD === '1';

    if (isLikelyDocker) {
      logger.debug('localhost failed in Docker, trying host.docker.internal as fallback');
      const hostDockerInternalUrl = workingUrl.replace(/localhost/g, 'host.docker.internal');
      const hostDockerInternalCandidates = [
        new URL('index.json', hostDockerInternalUrl).toString(),
        new URL('stories.json', hostDockerInternalUrl).toString(),
      ];

      for (const hostDockerInternalCandidate of hostDockerInternalCandidates) {
        attemptedUrls.push(hostDockerInternalCandidate);
        try {
          logger.debug(
            `Attempting host.docker.internal fallback fetch from: ${hostDockerInternalCandidate}`,
          );
          const res = await fetch(hostDockerInternalCandidate, {
            signal: AbortSignal.timeout(10000),
          });
          if (res.ok) {
            indexData = await res.json();
            workingUrl = hostDockerInternalUrl; // Update working URL to use host.docker.internal
            logger.debug(`Successfully loaded story index from host.docker.internal`);
            break;
          } else {
            const errorMsg = `HTTP ${res.status} ${res.statusText}`;
            errors.push(`${hostDockerInternalCandidate}: ${errorMsg}`);
          }
        } catch (e) {
          const err = e as Error;
          let errorMsg = err.message;
          if (err.message === 'fetch failed') {
            errorMsg =
              'fetch failed (connection refused - host.docker.internal may not be available)';
          }
          errors.push(`${hostDockerInternalCandidate}: ${errorMsg}`);
          logger.debug(`host.docker.internal fallback fetch failed: ${errorMsg}`);
        }
      }

      // If host.docker.internal also failed, try Docker gateway IP as fallback
      if (!indexData) {
        logger.debug(
          'host.docker.internal failed, attempting to detect Docker gateway IP as fallback',
        );
        const gatewayIP = getDockerGatewayIP();
        if (gatewayIP) {
          logger.debug(`Detected Docker gateway IP: ${gatewayIP}, trying as fallback`);
          const gatewayUrl = workingUrl.replace(/localhost|host\.docker\.internal/g, gatewayIP);
          const gatewayCandidates = [
            new URL('index.json', gatewayUrl).toString(),
            new URL('stories.json', gatewayUrl).toString(),
          ];

          for (const gatewayCandidate of gatewayCandidates) {
            attemptedUrls.push(gatewayCandidate);
            try {
              logger.debug(`Attempting gateway IP fallback fetch from: ${gatewayCandidate}`);
              const res = await fetch(gatewayCandidate, {
                signal: AbortSignal.timeout(10000),
              });
              if (res.ok) {
                indexData = await res.json();
                workingUrl = gatewayUrl; // Update working URL to use gateway IP
                logger.debug(
                  `Successfully loaded story index from Docker gateway IP: ${gatewayIP}`,
                );
                break;
              } else {
                const errorMsg = `HTTP ${res.status} ${res.statusText}`;
                errors.push(`${gatewayCandidate}: ${errorMsg}`);
              }
            } catch (e) {
              const err = e as Error;
              let errorMsg = err.message;
              if (err.message === 'fetch failed') {
                errorMsg = 'fetch failed (connection refused - gateway IP may not be accessible)';
              }
              errors.push(`${gatewayCandidate}: ${errorMsg}`);
              logger.debug(`Gateway IP fallback fetch failed: ${errorMsg}`);
            }
          }
        }
      }
    }
  }

  if (!indexData) {
    logger.error('Failed to load story index from any candidate location');
    // Check if we're likely running in Docker
    const isLikelyDocker =
      process.env.DOCKER_CONTAINER === 'true' ||
      fs.existsSync('/.dockerenv') ||
      (process.env.HOSTNAME && process.env.HOSTNAME.includes('docker')) ||
      process.env.DOCKER_BUILD === '1';

    // Detect what was attempted
    const triedLocalhost = attemptedUrls.some((url) => url.includes('localhost'));
    const triedHostDockerInternal = attemptedUrls.some((url) =>
      url.includes('host.docker.internal'),
    );

    const errorMsg = [
      'Could not load Storybook index.json from server or static files.',
      '',
      'Attempted locations:',
      ...attemptedUrls.map((url) => `  • ${url}`),
      ...candidates.filter((c) => !c.startsWith('http')).map((file) => `  • ${file} (static file)`),
      '',
      'Common issues:',
      '  • Storybook server is not running or accessible',
      isLikelyDocker && triedLocalhost && triedHostDockerInternal
        ? '  • Both localhost and host.docker.internal failed - Storybook may not be running or accessible'
        : isLikelyDocker && triedHostDockerInternal
          ? '  • host.docker.internal may not be available (Linux requires --add-host=host.docker.internal:host-gateway)'
          : isLikelyDocker && triedLocalhost
            ? '  • localhost failed - if using --network host, ensure Storybook is running on the host'
            : isLikelyDocker
              ? '  • Network connectivity issue - check Docker networking configuration'
              : '  • Wrong URL or port (check that Storybook is running)',
      '  • Storybook static build not found in expected location',
      '  • Network connectivity or firewall issues',
      '',
      'Troubleshooting steps:',
      isLikelyDocker && triedLocalhost && triedHostDockerInternal
        ? [
            `  • Verify Storybook is running: curl http://localhost:${port}`,
            `  • If using --network host, ensure Storybook is accessible on the host`,
            `  • If using normal Docker networking, ensure Storybook is accessible via host.docker.internal`,
            `  • Check Docker network configuration and firewall settings`,
          ]
        : isLikelyDocker && triedHostDockerInternal
          ? [
              `  • Add --add-host=host.docker.internal:host-gateway to your docker run command`,
              `  • Or use --network host mode: docker run --network host ...`,
              `  • Or ensure Storybook is accessible from the container`,
            ]
          : isLikelyDocker
            ? [`  • Check that Storybook is running: curl http://localhost:${port}`]
            : [`  • Check that Storybook is running: curl http://localhost:${port}`],
      '  • Verify Storybook index.json is accessible',
      '  • Try with --debug flag for more detailed output',
      '',
      'Recent errors:',
      ...errors.slice(-3).map((err) => `  • ${err}`), // Show last 3 errors
    ]
      .flat()
      .join('\n');

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
    .map((s: any) => ({
      id: String(s.id ?? s.sid ?? ''),
      title: String(s.title ?? s.kind ?? ''),
      name: String(s.name ?? s.story ?? ''),
      parameters: s.parameters,
      globals: s.globals,
    }))
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
    const match = (patterns?: string[]): boolean =>
      !patterns || patterns.some((p) => hay.includes(p.toLowerCase()));
    if (includes && !match(includes)) return false;
    if (excludes && match(excludes)) return false;
    return true;
  });

  const mapped: DiscoveredStory[] = filtered.map((s) => ({
    ...s,
    url: new URL(`iframe.html?id=${encodeURIComponent(s.id)}`, workingUrl).toString(),
    snapshotRelPath: toSnapshotPath(s),
  }));

  logger.info(
    `Discovered ${mapped.length} stories (${stories.length} total, ${stories.length - mapped.length} excluded)`,
  );
  logger.debug(`Story filtering: total=${stories.length}, after filters=${mapped.length}`);

  return mapped;
};
