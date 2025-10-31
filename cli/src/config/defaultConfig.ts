/*
 * Default configuration for Storybook Visual Regression CLI
 */
export type ViewportSize = { name: string; width: number; height: number };

export type VisualRegressionConfig = {
	url: string;
	outputDir: string;
	snapshotPath: string;
	resultsPath: string;
	browser: 'chromium' | 'firefox' | 'webkit';
	workers?: number;
	retries: number;
	maxFailures?: number;
	threshold: number; // 0..1
	maxDiffPixels: number;
	fullPage: boolean;
	viewportSizes: ViewportSize[];
	defaultViewport: string;
	discoverViewports: boolean;
	mutationWait: number;
	mutationTimeout: number;
	snapshotRetries: number;
	snapshotDelay: number;
	includeStories?: string[];
	excludeStories?: string[];
	grep?: string;
	disableAnimations: boolean;
	mockDate?: boolean | string | number;
	frozenTime?: number;
	timezone?: string;
	locale?: string;
	masks?: Record<string, Array<{ selector?: string; x?: number; y?: number; width?: number; height?: number }>>;
	perStory?: Record<string, Partial<{
		threshold: number;
		viewport: string | { width: number; height: number };
		snapshotDelay: number;
		mutationWait: number;
		mutationTimeout: number;
		masks: Array<{ selector?: string; x?: number; y?: number; width?: number; height?: number }>;
	}>>;
};

export const defaultConfig = (): VisualRegressionConfig => {
	const outputDir = 'visual-regression';
	return {
		url: 'http://localhost:6006',
		outputDir,
		snapshotPath: `${outputDir}/snapshots`,
		resultsPath: `${outputDir}/results`,
		browser: 'chromium',
		workers: undefined,
		retries: 0,
		maxFailures: undefined,
		threshold: 0.2,
		maxDiffPixels: 0,
		fullPage: false,
		viewportSizes: [
			{ name: 'mobile', width: 375, height: 667 },
			{ name: 'tablet', width: 768, height: 1024 },
			{ name: 'desktop', width: 1024, height: 768 }
		],
		defaultViewport: 'desktop',
		discoverViewports: true,
		mutationWait: 200,
		mutationTimeout: 1000,
		snapshotRetries: 1,
		snapshotDelay: 0,
		includeStories: undefined,
		excludeStories: undefined,
		grep: undefined,
		disableAnimations: true,
		mockDate: false,
		frozenTime: undefined,
		timezone: undefined,
		locale: undefined,
		masks: undefined,
		perStory: undefined
	};
};

export type ResolvedPaths = {
	snapshotPath: string;
	resultsPath: string;
};


