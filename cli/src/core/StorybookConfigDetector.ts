import { type RuntimeConfig } from '../config.js';

export interface ViewportSize {
  name: string;
  width: number;
  height: number;
}

export interface DetectedViewports {
  viewportSizes?: ViewportSize[];
  defaultViewport?: string;
}

/**
 * Modern approach for Storybook 8+
 * Uses the index.json API and story metadata
 */
export const detectViewports = async (config: RuntimeConfig): Promise<DetectedViewports> => {
  if (!config.discoverViewports) return {};

  // Method 1: Try to get viewport config from preview.js via index.json
  try {
    const indexUrl = new URL('index.json', config.url).toString();
    const res = await fetch(indexUrl);

    if (res.ok) {
      const data = await res.json();

      // Check if any story has viewport parameters
      const stories = data.entries || data.stories || {};
      const viewports = new Map<string, ViewportSize>();
      let defaultViewport: string | undefined;

      // Scan stories for viewport configurations
      for (const [storyId, story] of Object.entries(stories as Record<string, any>)) {
        // Check story-level viewport parameters
        const storyViewports = story.parameters?.viewport?.viewports;
        const storyDefault = story.parameters?.viewport?.defaultViewport;

        if (storyDefault && !defaultViewport) {
          defaultViewport = storyDefault;
        }

        if (storyViewports && typeof storyViewports === 'object') {
          for (const [name, viewport] of Object.entries(storyViewports as Record<string, any>)) {
            if (!viewports.has(name) && viewport.styles) {
              const width = parseSize(viewport.styles.width);
              const height = parseSize(viewport.styles.height);

              if (width > 0 && height > 0) {
                viewports.set(name, { name, width, height });
              }
            }
          }
        }

        // Check globals for viewport selection (Storybook 8+ way)
        const globalsViewport = story.globals?.viewport;
        if (globalsViewport) {
          if (typeof globalsViewport === 'string') {
            defaultViewport = globalsViewport;
          } else if (globalsViewport.value) {
            defaultViewport = globalsViewport.value;
          }
        }
      }

      if (viewports.size > 0) {
        return {
          viewportSizes: Array.from(viewports.values()),
          defaultViewport,
        };
      }
    }
  } catch (error) {
    // Silently fail - this is best-effort detection
  }

  // Method 2: Try to fetch a known story and extract viewport config from its metadata
  try {
    // Try the iframe endpoint with a story ID
    const iframeUrl = new URL('iframe.html', config.url);
    const res = await fetch(iframeUrl.toString());

    if (res.ok) {
      const html = await res.text();

      // Try to extract viewport config from the HTML
      // Look for STORYBOOK_PREVIEW_DATA or similar injected data
      const configMatch = html.match(/window\.__STORYBOOK_PREVIEW__\s*=\s*({[\s\S]*?});/);
      if (configMatch) {
        try {
          const previewData = JSON.parse(configMatch[1]);
          const viewportConfig = previewData.parameters?.viewport;

          if (viewportConfig?.viewports) {
            const viewportSizes = Object.entries(viewportConfig.viewports)
              .map(([name, v]: [string, any]) => ({
                name,
                width: parseSize(v.styles?.width || v.width),
                height: parseSize(v.styles?.height || v.height),
              }))
              .filter((v) => v.width > 0 && v.height > 0);

            return {
              viewportSizes,
              defaultViewport: viewportConfig.defaultViewport,
            };
          }
        } catch (e) {
          // Silently fail
        }
      }
    }
  } catch (error) {
    // Silently fail
  }

  return {};
};

/**
 * Alternative: Use Playwright to directly access Storybook's Manager API
 * This is the most reliable method for Storybook 8+
 */
export const detectViewportsWithPlaywright = async (page: any): Promise<DetectedViewports> => {
  try {
    const viewportData = await page.evaluate(() => {
      // Access the Manager API
      const api = (window as any).__STORYBOOK_MANAGER_API__;
      if (!api) return null;

      // Get current story to find viewport config
      const currentStory = api.getCurrentStoryData?.();
      const globals = api.getGlobals?.();

      // Get viewport configuration from parameters
      const viewportParams = currentStory?.parameters?.viewport;
      const viewports = viewportParams?.viewports || {};
      const defaultViewport =
        viewportParams?.defaultViewport || globals?.viewport?.value || globals?.viewport;

      // Convert viewports to array
      const viewportSizes = Object.entries(viewports)
        .map(([name, v]: [string, any]) => {
          const width = v.styles?.width || v.width || '0';
          const height = v.styles?.height || v.height || '0';

          return {
            name,
            width: parseInt(String(width).replace(/\D/g, ''), 10) || 0,
            height: parseInt(String(height).replace(/\D/g, ''), 10) || 0,
          };
        })
        .filter((v: any) => v.width > 0 && v.height > 0);

      return {
        viewportSizes,
        defaultViewport:
          typeof defaultViewport === 'string' ? defaultViewport : defaultViewport?.value,
      };
    });

    return viewportData || {};
  } catch (error) {
    // Silently fail
    return {};
  }
};

/**
 * Alternative: Access viewport from story iframe directly
 * Works when you're already on a story page
 */
export const detectViewportsFromIframe = async (page: any): Promise<DetectedViewports> => {
  try {
    const viewportData = await page.evaluate(() => {
      const iframe = document.querySelector('#storybook-preview-iframe') as HTMLIFrameElement;
      if (!iframe?.contentWindow) return null;

      const iframeWindow = iframe.contentWindow as any;
      const preview = iframeWindow.__STORYBOOK_PREVIEW__;

      if (!preview) return null;

      // Get viewport config from preview
      const viewportParams = preview.parameters?.viewport;
      const globals = preview.globals;

      const viewports = viewportParams?.viewports || {};
      const defaultViewport =
        viewportParams?.defaultViewport || globals?.viewport?.value || globals?.viewport;

      const viewportSizes = Object.entries(viewports)
        .map(([name, v]: [string, any]) => {
          const width = v.styles?.width || v.width || '0';
          const height = v.styles?.height || v.height || '0';

          return {
            name,
            width: parseInt(String(width).replace(/\D/g, ''), 10) || 0,
            height: parseInt(String(height).replace(/\D/g, ''), 10) || 0,
          };
        })
        .filter((v: any) => v.width > 0 && v.height > 0);

      return {
        viewportSizes,
        defaultViewport:
          typeof defaultViewport === 'string' ? defaultViewport : defaultViewport?.value,
      };
    });

    return viewportData || {};
  } catch (error) {
    // Silently fail
    return {};
  }
};

/**
 * Get the viewport for a specific story
 */
export const getStoryViewport = async (
  page: any,
  storyId: string,
): Promise<{ width: number; height: number } | null> => {
  try {
    return await page.evaluate((id: string) => {
      // Try to access from iframe (when on story page)
      const iframe = document.querySelector('#storybook-preview-iframe') as HTMLIFrameElement;
      if (iframe?.contentWindow) {
        const iframeWindow = iframe.contentWindow as any;
        const preview = iframeWindow.__STORYBOOK_PREVIEW__;

        if (preview) {
          // Get story data from preview
          const story = preview.storyStore?.storyById?.(id) || preview.getCurrentStoryData?.();

          if (story) {
            // Check for globals viewport (Storybook 8+ way)
            const globalsViewport = story.globals?.viewport;
            let viewportName: string | undefined;

            if (typeof globalsViewport === 'string') {
              viewportName = globalsViewport;
            } else if (globalsViewport?.value) {
              viewportName = globalsViewport.value;
            } else if (story.parameters?.viewport?.defaultViewport) {
              viewportName = story.parameters.viewport.defaultViewport;
            }

            if (viewportName) {
              // Get viewport dimensions
              const viewports = story.parameters?.viewport?.viewports || {};
              const viewport = viewports[viewportName];

              if (viewport) {
                const width = parseInt(
                  String(viewport.styles?.width || viewport.width || '0').replace(/\D/g, ''),
                  10,
                );
                const height = parseInt(
                  String(viewport.styles?.height || viewport.height || '0').replace(/\D/g, ''),
                  10,
                );

                if (width > 0 && height > 0) {
                  return { width, height };
                }
              }
            }
          }
        }
      }

      // Fallback: Try Manager API (when on manager page)
      const api = (window as any).__STORYBOOK_MANAGER_API__;
      if (api) {
        // Get story data
        const story = api.storyStore?.storyById?.(id) || api.getCurrentStoryData?.();

        if (story) {
          // Check for globals viewport (Storybook 8+ way)
          const globalsViewport = story.globals?.viewport;
          let viewportName: string | undefined;

          if (typeof globalsViewport === 'string') {
            viewportName = globalsViewport;
          } else if (globalsViewport?.value) {
            viewportName = globalsViewport.value;
          } else if (story.parameters?.viewport?.defaultViewport) {
            viewportName = story.parameters.viewport.defaultViewport;
          }

          if (!viewportName) return null;

          // Get viewport dimensions
          const viewports = story.parameters?.viewport?.viewports || {};

          const viewport = viewports[viewportName];

          if (!viewport) return null;

          const width = parseInt(
            String(viewport.styles?.width || viewport.width || '0').replace(/\D/g, ''),
            10,
          );
          const height = parseInt(
            String(viewport.styles?.height || viewport.height || '0').replace(/\D/g, ''),
            10,
          );

          return width > 0 && height > 0 ? { width, height } : null;
        }
      }

      return null;
    }, storyId);
  } catch (error) {
    // Silently fail
    return null;
  }
};

// Helper to parse size strings like "375px", "100%", etc.
function parseSize(size: string | number | undefined): number {
  if (typeof size === 'number') return size;
  if (!size) return 0;

  const str = String(size);
  const match = str.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}
