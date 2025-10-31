import fs from 'node:fs';
import path from 'node:path';
import { type RuntimeConfig } from '../config.js';

export const getRuntimeOptionsPath = (baseDir: string): string =>
	path.resolve(baseDir, '.cache/storybook-visual-regression/runtime-options.json');

export const writeRuntimeOptions = (
	config: RuntimeConfig & { stories: Array<{ id: string; title: string; name: string; url: string; snapshotRelPath: string }> },
	outputPath: string
): void => {
	fs.mkdirSync(path.dirname(outputPath), { recursive: true });
	fs.writeFileSync(
		outputPath,
		`${JSON.stringify({
			config: {
				url: config.url,
				resultsPath: config.resultsPath,
				snapshotPath: config.snapshotPath,
				threshold: config.threshold,
				maxDiffPixels: config.maxDiffPixels,
				fullPage: config.fullPage,
				mutationWait: config.mutationWait,
				mutationTimeout: config.mutationTimeout,
				snapshotRetries: config.snapshotRetries,
				snapshotDelay: config.snapshotDelay,
				disableAnimations: config.disableAnimations,
				frozenTime: config.frozenTime,
				timezone: config.timezone,
				locale: config.locale,
				masks: config.masks,
				perStory: config.perStory
			},
			stories: config.stories
		}, null, 2)}\n`,
		'utf8'
	);
};


