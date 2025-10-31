import fs from 'node:fs';
import path from 'node:path';
import { type RuntimeConfig } from '../config.js';

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
	segment.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();

const toSnapshotPath = (entry: StoryIndexEntry): string => {
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
		config.resolvePath('storybook-static/stories.json')
	];

	let indexData: any;
	for (const candidate of candidates) {
		if (candidate.startsWith('http')) {
			try {
				if (config.debug) process.stdout.write(`Discovery: GET ${candidate}\n`);
				const res = await fetch(candidate);
				if (res.ok) {
					indexData = await res.json();
					if (config.debug) process.stdout.write(`Discovery: loaded ${candidate}\n`);
					break;
				} else if (config.debug) {
					process.stdout.write(`Discovery: ${candidate} -> HTTP ${res.status}\n`);
				}
			} catch (e) {
				if (config.debug) process.stdout.write(`Discovery: failed ${candidate} -> ${(e as Error).message}\n`);
			}
		} else {
			const data = readJsonSafe(candidate);
			if (data) {
				indexData = data;
				if (config.debug) process.stdout.write(`Discovery: loaded ${candidate}\n`);
				break;
			}
		}
	}

	if (!indexData) {
		throw new Error('Could not load Storybook index.json from server or static files');
	}

	const source = ((): any[] => {
		if (indexData && typeof indexData === 'object') {
			// Storybook 6/7 style: { stories: { [id]: { id, title, name } } }
			if (indexData.stories && typeof indexData.stories === 'object') return Object.values(indexData.stories as any);
			// Some builds may expose { entries: { [id]: { id, title, name } } }
			if (indexData.entries && typeof indexData.entries === 'object') return Object.values(indexData.entries as any);
			// Already an array?
			if (Array.isArray(indexData)) return indexData as any[];
		}
		return [];
	})();

	const stories: StoryIndexEntry[] = source.map((s: any) => ({
		id: String(s.id ?? s.sid ?? ''),
		title: String(s.title ?? s.kind ?? ''),
		name: String(s.name ?? s.story ?? '')
	})).filter((s) => s.id && s.title && s.name);

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
		snapshotRelPath: toSnapshotPath(s)
	}));

	if (config.debug) {
		process.stdout.write(`Discovery: total stories in index=${stories.length}, after filters=${mapped.length}\n`);
	}

	return mapped;
};


