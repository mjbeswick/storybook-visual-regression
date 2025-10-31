import { type RuntimeConfig } from '../config.js';

export type DetectedViewports = {
	viewportSizes?: Array<{ name: string; width: number; height: number }>;
	defaultViewport?: string;
};

export const detectViewports = async (config: RuntimeConfig): Promise<DetectedViewports> => {
	if (!config.discoverViewports) return {};
	// Best-effort: try Storybook globals endpoint (not standardized across versions)
	try {
		const res = await fetch(new URL('globals.json', config.url).toString());
		if (res.ok) {
			const data = (await res.json()) as any;
			const sizes = data?.addons?.viewport?.viewports as any;
			const defaultViewport = data?.addons?.viewport?.defaultViewport as string | undefined;
			if (sizes && typeof sizes === 'object') {
				const viewportSizes = Object.entries(sizes).map(([name, v]: [string, any]) => ({
					name,
					width: Number(v?.styles?.width ?? v?.width ?? 0),
					height: Number(v?.styles?.height ?? v?.height ?? 0)
				})).filter((v) => v.width > 0 && v.height > 0);
				return { viewportSizes, defaultViewport };
			}
		}
	} catch {
		/* noop */
	}
	return {};
};


