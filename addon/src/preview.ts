/**
 * Preview-side code for the Visual Regression addon.
 *
 * This runs in the browser and communicates with the API server
 * started by the addon preset (which runs in Node.js).
 */

import { EVENTS } from './constants';
import type { FailedResult } from './types';

const API_BASE_URL = 'http://localhost:6007';

// Try to get the addons channel from the global window object
// This is how Storybook addons communicate between manager and preview
type Channel = {
  emit: (event: string, data?: unknown) => void;
  on: (event: string, callback: (data?: unknown) => void) => void;
  off: (event: string, callback: (data?: unknown) => void) => void;
};

const getChannel = (): Channel | null => {
  if (
    typeof window !== 'undefined' &&
    (window as unknown as { __STORYBOOK_ADDONS_CHANNEL__?: Channel }).__STORYBOOK_ADDONS_CHANNEL__
  ) {
    return (window as unknown as { __STORYBOOK_ADDONS_CHANNEL__: Channel })
      .__STORYBOOK_ADDONS_CHANNEL__;
  }
  return null;
};

// Track failed stories and their diff information
type FailedStoryData = {
  storyId: string;
  storyName: string;
  status: string;
  diffImagePath?: string;
  actualImagePath?: string;
  expectedImagePath?: string;
  error?: string;
};
const failedStories: Map<string, FailedStoryData> = new Map();

// Guard to prevent multiple initializations (stored on window to persist across HMR)
declare global {
  interface Window {
    __VISUAL_REGRESSION_INITIALIZED__?: boolean;
  }
}

// Initialize the addon by setting up event listeners
const initializeAddon = async () => {
  // Prevent multiple initializations
  if (typeof window !== 'undefined' && window.__VISUAL_REGRESSION_INITIALIZED__) {
    return;
  }

  const channel = getChannel();

  if (!channel) {
    setTimeout(initializeAddon, 100);
    return;
  }

  // Mark as initialized before setting up handlers
  if (typeof window !== 'undefined') {
    window.__VISUAL_REGRESSION_INITIALIZED__ = true;
  }

  // Load existing failed test results on initialization (no sidebar highlighting)
  try {
    const response = await fetch(`${API_BASE_URL}/get-failed-results`);
    if (response.ok) {
      const failedResults = await response.json();

      // Populate failedStories map with existing results
      failedResults.forEach((result: FailedResult) => {
        failedStories.set(result.storyId, {
          storyId: result.storyId,
          storyName: result.storyName,
          status: 'failed',
          diffImagePath: result.diffImagePath,
          actualImagePath: result.actualImagePath,
          expectedImagePath: result.expectedImagePath,
        });

        // Also emit TEST_RESULT events for existing failed results so Tool component can access them
        channel.emit(EVENTS.TEST_RESULT, {
          storyId: result.storyId,
          storyName: result.storyName,
          status: 'failed',
          diffPath: result.diffImagePath,
          actualPath: result.actualImagePath,
          expectedPath: result.expectedImagePath,
        });
      });

      // No longer emitting highlight events
    }
  } catch {
    // ignore failed results loading errors
  }

  // Live-watch the results directory via SSE and keep failures in sync
  const startFailedResultsWatcher = () => {
    try {
      const es = new EventSource(`${API_BASE_URL}/watch-failed`);

      es.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload && payload.type === 'failed-results' && Array.isArray(payload.results)) {
            const incoming = payload.results as Array<{
              storyId: string;
              storyName: string;
              diffImagePath?: string;
              actualImagePath?: string;
              expectedImagePath?: string;
            }>;

            // Deduplicate by storyId – keep the entry with the highest retry index
            const getRetryIndex = (p?: string): number => {
              if (!p) return 0;
              const m = p.match(/-retry(\d+)/);
              return m ? parseInt(m[1], 10) : 0;
            };
            const bestById = new Map<string, (typeof incoming)[number]>();
            for (const r of incoming) {
              const existing = bestById.get(r.storyId);
              if (!existing) {
                bestById.set(r.storyId, r);
              } else {
                if (getRetryIndex(r.diffImagePath) > getRetryIndex(existing.diffImagePath)) {
                  bestById.set(r.storyId, r);
                }
              }
            }

            const incomingIds = new Set(Array.from(bestById.keys()));

            // Emit passed for stories that are no longer failing
            for (const existingId of Array.from(failedStories.keys())) {
              if (!incomingIds.has(existingId)) {
                failedStories.delete(existingId);
                channel.emit(EVENTS.TEST_RESULT, {
                  storyId: existingId,
                  storyName: undefined,
                  status: 'passed',
                });
              }
            }

            // Upsert current failures and emit events
            for (const result of bestById.values()) {
              failedStories.set(result.storyId, {
                storyId: result.storyId,
                storyName: result.storyName,
                status: 'failed',
                diffImagePath: result.diffImagePath,
                actualImagePath: result.actualImagePath,
                expectedImagePath: result.expectedImagePath,
              });

              channel.emit(EVENTS.TEST_RESULT, {
                storyId: result.storyId,
                storyName: result.storyName,
                status: 'failed',
                diffPath: result.diffImagePath,
                actualPath: result.actualImagePath,
                expectedPath: result.expectedImagePath,
              });
            }
          }
        } catch {
          // ignore malformed messages
        }
      };

      es.onerror = () => {
        try {
          es.close();
        } catch {
          // ignore close errors
        }
        // retry shortly
        setTimeout(startFailedResultsWatcher, 2000);
      };
    } catch {
      // Retry if EventSource cannot be started yet
      setTimeout(startFailedResultsWatcher, 2000);
    }
  };

  startFailedResultsWatcher();

  // Listen for story changes to show/hide diff overlay
  channel.on('storyChanged', (data: unknown) => {
    const storyId = data as string;
    if (failedStories.has(storyId)) {
      const storyData = failedStories.get(storyId);
      if (storyData && storyData.diffImagePath) {
        // Show diff overlay for failed story
        window.postMessage(
          {
            type: 'visual-regression-show-diff',
            storyId: storyData.storyId,
            diffImagePath: storyData.diffImagePath,
            actualImagePath: storyData.actualImagePath,
            expectedImagePath: storyData.expectedImagePath,
          },
          '*',
        );
      }
    } else {
      // Hide diff overlay for non-failed stories
      window.postMessage(
        {
          type: 'visual-regression-hide-diff',
        },
        '*',
      );
    }
  });

  // Listen for test requests from the manager
  channel.on(EVENTS.RUN_TEST, async (data: unknown) => {
    const eventData = data as { storyId?: string };
    const storyId = eventData.storyId;
    if (!storyId) {
      channel.emit(EVENTS.TEST_COMPLETE);
      return;
    }

    channel.emit(EVENTS.TEST_STARTED);

    // Get story name for display
    const storyName = getStoryNameFromId(storyId);

    try {
      // Call the API server to run the test
      const response = await fetch(`${API_BASE_URL}/test`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'test',
          storyId,
          storyName,
        }),
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      // Read the raw terminal stream
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });

          // Stream raw terminal output directly to panel
          if (chunk) {
            channel.emit(EVENTS.LOG_OUTPUT, chunk);
          }

          // Note: We no longer parse JSON events since we're using pure terminal streaming
          // The filtered reporter provides all feedback through terminal output
          // Test completion is detected when the stream ends
        }
      } finally {
        reader.releaseLock();
      }

      // Stream ended - test is complete
      channel.emit(EVENTS.TEST_COMPLETE);
    } catch {
      channel.emit(EVENTS.TEST_COMPLETE);
    }
  });

  // Listen for "run all tests" requests from the manager
  channel.on(EVENTS.RUN_ALL_TESTS, async () => {
    channel.emit(EVENTS.TEST_STARTED);

    try {
      const response = await fetch(`${API_BASE_URL}/test`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'test-all',
        }),
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      // Read the raw terminal stream
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });

          // Stream raw terminal output directly to panel
          if (chunk) {
            channel.emit(EVENTS.LOG_OUTPUT, chunk);
          }

          // Note: We no longer parse JSON events since we're using pure terminal streaming
          // The filtered reporter provides all feedback through terminal output
          // Test completion is detected when the stream ends
        }
      } finally {
        reader.releaseLock();
      }

      // Stream ended - test is complete
      channel.emit(EVENTS.TEST_COMPLETE);
    } catch {
      channel.emit(EVENTS.TEST_COMPLETE);
    }
  });

  // Listen for baseline update requests
  channel.on(EVENTS.UPDATE_BASELINE, async (data: unknown) => {
    const eventData = data as { storyId?: string };
    const storyId = eventData.storyId;
    if (!storyId) {
      channel.emit(EVENTS.TEST_COMPLETE);
      return;
    }

    channel.emit(EVENTS.TEST_STARTED);

    const storyName = getStoryNameFromId(storyId);

    try {
      const response = await fetch(`${API_BASE_URL}/test`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'update-baseline',
          storyId,
          storyName,
        }),
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      // Read the raw terminal stream
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });

          // Stream raw terminal output directly to panel
          if (chunk) {
            channel.emit(EVENTS.LOG_OUTPUT, chunk);
          }

          // Note: We no longer parse JSON events since we're using pure terminal streaming
          // The filtered reporter provides all feedback through terminal output
          // Test completion is detected when the stream ends
        }
      } finally {
        reader.releaseLock();
      }

      // Stream ended - test is complete
      channel.emit(EVENTS.TEST_COMPLETE);
    } catch {
      channel.emit(EVENTS.TEST_COMPLETE);
    }
  });

  // Listen for clear results requests
  channel.on(EVENTS.CLEAR_RESULTS, () => {
    failedStories.clear();
    // Hide any visible diff overlay
    window.postMessage(
      {
        type: 'visual-regression-hide-diff',
      },
      '*',
    );
  });
};

// Helper to convert Storybook ID to human-readable name
const getStoryNameFromId = (storyId: string): string => {
  // Example: "screens-basket--empty" -> "Screens / Basket / Empty"
  const parts = storyId.split('--');
  const title = parts[0]
    .split('-')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' / ');
  const name = parts[1]
    ? parts[1]
        .split('-')
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join(' ')
    : '';
  return `${title}${name ? ` / ${name}` : ''}`;
};

// Initialize the addon when the Storybook channel is ready
if (typeof window !== 'undefined') {
  initializeAddon();
}
