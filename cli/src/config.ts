import fs from 'node:fs';
import path from 'node:path';
import { defaultConfig, type VisualRegressionConfig } from './config/defaultConfig.js';

export type CliFlags = {
	config?: string;
	url?: string;
	output?: string;
	workers?: number;
	command?: string;
	webserverTimeout?: number;
	retries?: number;
	maxFailures?: number;
	timezone?: string;
	locale?: string;
	quiet?: boolean;
	debug?: boolean;
	logLevel?: 'silent' | 'error' | 'warn' | 'info' | 'debug';
	progress?: boolean;
	browser?: 'chromium' | 'firefox' | 'webkit';
	threshold?: number;
	maxDiffPixels?: number;
	fullPage?: boolean;
	overlayTimeout?: number;
	testTimeout?: number;
	snapshotRetries?: number;
	snapshotDelay?: number;
	mutationWait?: number;
	mutationTimeout?: number;
	grep?: string;
	include?: string;
	exclude?: string;
	installBrowsers?: string | boolean;
	installDeps?: boolean;
	notFoundCheck?: boolean;
	notFoundRetryDelay?: number;
	update?: boolean;
	missingOnly?: boolean;
	failedOnly?: boolean;
	saveConfig?: boolean;
	showProgress?: boolean;
	summary?: boolean;
	mockDate?: boolean | string | number;
	jsonRpc?: boolean;
};

export type RuntimeConfig = VisualRegressionConfig & {
	resolvePath: (p: string) => string;
	flags: CliFlags;
	command?: string;
	webserverTimeout?: number;
	quiet: boolean;
	debug: boolean;
	logLevel: 'silent' | 'error' | 'warn' | 'info' | 'debug';
	progress: boolean;
	installBrowsers?: string | boolean;
	installDeps?: boolean;
	notFoundCheck: boolean;
	notFoundRetryDelay: number;
	update: boolean;
	missingOnly: boolean;
	failedOnly: boolean;
	testTimeout?: number;
	overlayTimeout?: number;
	showProgress: boolean;
	summary: boolean;
	mockDate?: boolean | string | number;
};

export const loadJsonFile = (maybePath?: string): Record<string, unknown> | undefined => {
	if (!maybePath) return undefined;
	const full = path.resolve(process.cwd(), maybePath);
	if (!fs.existsSync(full)) return undefined;
	const raw = fs.readFileSync(full, 'utf8');
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch (err) {
		throw new Error(`Invalid JSON at ${full}: ${(err as Error).message}`);
	}
};

const normalizePatterns = (val?: string | string[]): string[] | undefined => {
	if (!val) return undefined;
	const list = Array.isArray(val) ? val : String(val).split(',');
	return list.map((s) => s.trim()).filter(Boolean);
};

export const resolveConfig = (flags: CliFlags): RuntimeConfig => {
	const base = defaultConfig();
	const fileConfigRaw = loadJsonFile(flags.config);
	const fileVisual = (fileConfigRaw?.visualRegression ?? {}) as Partial<VisualRegressionConfig>;

	const merged: VisualRegressionConfig = {
		...base,
		...fileVisual,
		url: flags.url ?? fileVisual.url ?? base.url,
		browser: (flags.browser ?? fileVisual.browser ?? base.browser) as RuntimeConfig['browser'],
		workers: flags.workers ?? fileVisual.workers ?? base.workers,
		threshold: flags.threshold ?? fileVisual.threshold ?? base.threshold,
		maxDiffPixels: flags.maxDiffPixels ?? fileVisual.maxDiffPixels ?? base.maxDiffPixels,
		fullPage: flags.fullPage ?? fileVisual.fullPage ?? base.fullPage,
		mutationWait: flags.mutationWait ?? fileVisual.mutationWait ?? base.mutationWait,
		mutationTimeout: flags.mutationTimeout ?? fileVisual.mutationTimeout ?? base.mutationTimeout,
		snapshotRetries: flags.snapshotRetries ?? fileVisual.snapshotRetries ?? base.snapshotRetries,
		snapshotDelay: flags.snapshotDelay ?? fileVisual.snapshotDelay ?? base.snapshotDelay,
		viewportSizes: fileVisual.viewportSizes ?? base.viewportSizes,
		defaultViewport: fileVisual.defaultViewport ?? base.defaultViewport,
		discoverViewports: fileVisual.discoverViewports ?? base.discoverViewports,
		includeStories: normalizePatterns(flags.include ?? fileVisual.includeStories),
		excludeStories: normalizePatterns(flags.exclude ?? fileVisual.excludeStories),
		grep: flags.grep ?? fileVisual.grep ?? base.grep,
		disableAnimations: fileVisual.disableAnimations ?? base.disableAnimations,
		mockDate: flags.mockDate ?? fileVisual.mockDate ?? base.mockDate ?? false,
		snapshotPath: ((): string => {
			const rootOut = flags.output ?? fileVisual.outputDir ?? base.outputDir;
			return path.join(rootOut, 'snapshots');
		})(),
		resultsPath: ((): string => {
			const rootOut = flags.output ?? fileVisual.outputDir ?? base.outputDir;
			return path.join(rootOut, 'results');
		})(),
		locale: fileVisual.locale ?? base.locale,
		timezone: fileVisual.timezone ?? base.timezone,
		frozenTime: fileVisual.frozenTime ?? base.frozenTime,
		masks: fileVisual.masks ?? base.masks,
		perStory: fileVisual.perStory ?? base.perStory,
		retries: flags.retries ?? fileVisual.retries ?? base.retries,
		maxFailures: flags.maxFailures ?? fileVisual.maxFailures ?? base.maxFailures
	};

	const envLog = (process.env.SVR_LOG_LEVEL as RuntimeConfig['logLevel']) || undefined;
	const logLevel: RuntimeConfig['logLevel'] = flags.logLevel || envLog || (flags.debug ? 'debug' : 'info');

	const runtime: RuntimeConfig = {
		...merged,
		resolvePath: (p: string) => path.resolve(process.cwd(), p),
		flags,
		command: flags.command,
		webserverTimeout: flags.webserverTimeout,
		quiet: Boolean(flags.quiet),
		debug: logLevel === 'debug' || Boolean(process.env.SVR_DEBUG || flags.debug),
		logLevel,
		progress: process.env.SVR_NO_PROGRESS ? false : flags.progress ?? true,
		installBrowsers: flags.installBrowsers,
		installDeps: flags.installDeps,
		notFoundCheck: Boolean(flags.notFoundCheck),
		notFoundRetryDelay: flags.notFoundRetryDelay ?? 200,
		update: Boolean(flags.update),
		missingOnly: Boolean(flags.missingOnly),
		failedOnly: Boolean(flags.failedOnly),
		testTimeout: flags.testTimeout,
		overlayTimeout: flags.overlayTimeout,
		showProgress: Boolean(flags.showProgress),
		summary: Boolean(flags.summary),
		mockDate: merged.mockDate ?? false
	};

	return runtime;
};

export const saveEffectiveConfig = (config: RuntimeConfig, filePath: string): void => {
	const data = {
		visualRegression: {
			url: config.url,
			outputDir: config.outputDir,
			snapshotPath: config.snapshotPath,
			resultsPath: config.resultsPath,
			browser: config.browser,
			workers: config.workers,
			retries: config.retries,
			maxFailures: config.maxFailures,
			threshold: config.threshold,
			maxDiffPixels: config.maxDiffPixels,
			fullPage: config.fullPage,
			viewportSizes: config.viewportSizes,
			defaultViewport: config.defaultViewport,
			discoverViewports: config.discoverViewports,
			mutationWait: config.mutationWait,
			mutationTimeout: config.mutationTimeout,
			snapshotRetries: config.snapshotRetries,
			snapshotDelay: config.snapshotDelay,
			includeStories: config.includeStories,
			excludeStories: config.excludeStories,
			grep: config.grep,
			disableAnimations: config.disableAnimations,
			mockDate: config.mockDate,
			frozenTime: config.frozenTime,
			timezone: config.timezone,
			locale: config.locale,
			masks: config.masks,
			perStory: config.perStory
		}
	};
	const dest = path.resolve(process.cwd(), filePath);
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.writeFileSync(dest, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
};


