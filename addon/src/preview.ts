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

// Initialize the addon by setting up event listeners
const initializeAddon = async () => {
  const channel = getChannel();

  if (!channel) {
    console.warn('[Visual Regression Addon] Channel not available, retrying in 100ms...');
    setTimeout(initializeAddon, 100);
    return;
  }

  console.log('[Visual Regression Addon] Initialized - API Server running on port 6007');

  // Load existing failed test results on initialization (no sidebar highlighting)
  try {
    const response = await fetch(`${API_BASE_URL}/get-failed-results`);
    if (response.ok) {
      const failedResults = await response.json();
      console.log('[Visual Regression] Loaded existing failed results:', failedResults);

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
  } catch (error) {
    console.warn('[Visual Regression] Could not load existing failed results:', error);
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

  // Stop any running tests when the page is about to reload/unload
  const stopRunningTests = async () => {
    try {
      await fetch(`${API_BASE_URL}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      console.log('[Visual Regression] Stopped running tests due to page reload');
    } catch {
      // Silent fail - page is reloading anyway
    }
  };

  // Listen for page unload/reload events
  window.addEventListener('beforeunload', stopRunningTests);
  window.addEventListener('unload', stopRunningTests);

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
      console.error('[Visual Regression] No story ID provided in event data');
      channel.emit(EVENTS.TEST_COMPLETE);
      return;
    }

    channel.emit(EVENTS.TEST_STARTED);

    // Get story name for display
    const storyName = getStoryNameFromId(storyId);

    console.log('[Visual Regression] Testing story:', storyId, storyName);

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

      // Read the event stream
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const payload = line.slice(6);
                // Stream raw output to panel
                channel.emit(EVENTS.LOG_OUTPUT, payload);
                const eventData = JSON.parse(payload);
                console.log('[Visual Regression] Received event:', eventData.type, eventData);

                if (eventData.type === 'test-result') {
                  console.log('[Visual Regression] Received test-result:', eventData);
                  // Handle individual test results
                  if (eventData.status === 'passed') {
                    console.log(`✅ Test Passed: ${eventData.title} [${eventData.storyId}]`);

                    // Remove from failed stories if it was there
                    failedStories.delete(eventData.storyId);

                    // Emit test result to manager
                    channel.emit(EVENTS.TEST_RESULT, {
                      storyId: eventData.storyId,
                      storyName: eventData.title,
                      status: eventData.status,
                    });
                    // Immediately refresh highlights so passed stories are un-highlighted
                    channel.emit(EVENTS.HIGHLIGHT_FAILED_STORIES, Array.from(failedStories.keys()));
                  } else if (eventData.status === 'failed') {
                    console.error(`❌ Test Failed: ${eventData.title} [${eventData.storyId}]`);
                    console.log('[Visual Regression] Failed test data:', eventData);
                    if (eventData.error) {
                      console.error('   Error:', eventData.error);
                    }

                    // Store failed story information
                    failedStories.set(eventData.storyId, {
                      storyId: eventData.storyId,
                      storyName: eventData.title,
                      status: eventData.status,
                      error: eventData.error,
                      diffImagePath: eventData.diffImagePath,
                      actualImagePath: eventData.actualImagePath,
                      expectedImagePath: eventData.expectedImagePath,
                    });

                    // Emit test result to manager
                    channel.emit(EVENTS.TEST_RESULT, {
                      storyId: eventData.storyId,
                      storyName: eventData.title,
                      status: eventData.status,
                      error: eventData.error,
                      diffImagePath: eventData.diffImagePath,
                      actualImagePath: eventData.actualImagePath,
                      expectedImagePath: eventData.expectedImagePath,
                    });

                    // No sidebar highlight updates
                  } else if (eventData.status === 'timedOut') {
                    console.warn(`⚠️ Test Timed Out: ${eventData.title} [${eventData.storyId}]`);

                    // Emit test result to manager
                    channel.emit(EVENTS.TEST_RESULT, {
                      storyId: eventData.storyId,
                      storyName: eventData.title,
                      status: eventData.status,
                      error: eventData.error,
                    });
                  }
                } else if (eventData.type === 'complete') {
                  if (eventData.exitCode === 0 || eventData.exitCode === null) {
                    console.log('[Visual Regression] Test completed successfully');
                  } else {
                    console.log(
                      '[Visual Regression] Test failed with exit code:',
                      eventData.exitCode,
                    );
                  }

                  // No sidebar highlight updates

                  channel.emit(EVENTS.TEST_COMPLETE);
                } else if (eventData.type === 'error') {
                  console.error('[Visual Regression] Test error:', eventData.error);
                  channel.emit(EVENTS.TEST_COMPLETE);
                }
              } catch {
                console.warn('[Visual Regression] Failed to parse event:', line);
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      console.error('[Visual Regression] Test failed:', error);
      channel.emit(EVENTS.TEST_COMPLETE);
    }
  });

  // Listen for "run all tests" requests from the manager
  channel.on(EVENTS.RUN_ALL_TESTS, async () => {
    channel.emit(EVENTS.TEST_STARTED);

    console.log('[Visual Regression] Running all tests...');

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

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const payload = line.slice(6);
                // Stream raw output to panel
                channel.emit(EVENTS.LOG_OUTPUT, payload);
                const eventData = JSON.parse(payload);
                console.log('[Visual Regression] Received event:', eventData.type, eventData);

                if (eventData.type === 'test-result') {
                  console.log('[Visual Regression] Received test-result:', eventData);
                  // Handle individual test results
                  const sid: string | undefined = eventData.storyId || eventData.id || undefined;
                  const title: string | undefined = eventData.title || eventData.storyName;
                  if (!sid) {
                    console.warn(
                      '[Visual Regression] Missing storyId on event, skipping:',
                      eventData,
                    );
                    continue;
                  }
                  if (eventData.status === 'passed') {
                    console.log(`✅ Test Passed: ${eventData.title} [${eventData.storyId}]`);

                    // Remove from failed stories if it was there
                    failedStories.delete(sid);

                    // Emit test result to manager
                    channel.emit(EVENTS.TEST_RESULT, {
                      storyId: sid,
                      storyName: title || sid || 'Unknown Story',
                      status: eventData.status,
                    });
                  } else if (eventData.status === 'failed') {
                    console.error(`❌ Test Failed: ${eventData.title} [${eventData.storyId}]`);
                    console.log('[Visual Regression] Failed test data:', eventData);
                    if (eventData.error) {
                      console.error('   Error:', eventData.error);
                    }

                    // Store failed story information
                    failedStories.set(sid, {
                      storyId: sid,
                      storyName: title || sid,
                      status: eventData.status,
                      error: eventData.error,
                      diffImagePath: eventData.diffImagePath,
                      actualImagePath: eventData.actualImagePath,
                      expectedImagePath: eventData.expectedImagePath,
                    });

                    // Emit test result to manager
                    channel.emit(EVENTS.TEST_RESULT, {
                      storyId: sid,
                      storyName: title || sid,
                      status: eventData.status,
                      error: eventData.error,
                      diffImagePath: eventData.diffImagePath,
                      actualImagePath: eventData.actualImagePath,
                      expectedImagePath: eventData.expectedImagePath,
                    });

                    // Emit updated failed stories list for highlighting
                    const failedStoryIds = Array.from(failedStories.keys());
                    console.log(
                      '[Visual Regression] Emitting HIGHLIGHT_FAILED_STORIES:',
                      failedStoryIds,
                    );
                    channel.emit(EVENTS.HIGHLIGHT_FAILED_STORIES, failedStoryIds);
                  } else if (eventData.status === 'timedOut') {
                    console.warn(`⚠️ Test Timed Out: ${eventData.title} [${eventData.storyId}]`);

                    // Emit test result to manager
                    channel.emit(EVENTS.TEST_RESULT, {
                      storyId: sid,
                      storyName: title || sid,
                      status: eventData.status,
                      error: eventData.error,
                    });
                  }
                } else if (eventData.type === 'complete') {
                  if (eventData.exitCode === 0 || eventData.exitCode === null) {
                    console.log('[Visual Regression] All tests completed successfully');
                  } else {
                    console.log(
                      '[Visual Regression] Some tests failed with exit code:',
                      eventData.exitCode,
                    );
                  }

                  // Emit failed stories to manager for highlighting
                  const failedStoryIds = Array.from(failedStories.keys());
                  channel.emit(EVENTS.HIGHLIGHT_FAILED_STORIES, failedStoryIds);

                  channel.emit(EVENTS.TEST_COMPLETE);
                } else if (eventData.type === 'error') {
                  console.error('[Visual Regression] Test error:', eventData.error);
                  channel.emit(EVENTS.TEST_COMPLETE);
                }
              } catch {
                console.warn('[Visual Regression] Failed to parse event:', line);
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      console.error('[Visual Regression] API call for all tests failed:', error);
      channel.emit(EVENTS.TEST_COMPLETE);
    }
  });

  // Listen for baseline update requests
  channel.on(EVENTS.UPDATE_BASELINE, async (data: unknown) => {
    console.log('[Visual Regression] Preview: Received UPDATE_BASELINE event:', data);
    const eventData = data as { storyId?: string };
    const storyId = eventData.storyId;
    if (!storyId) {
      console.error('[Visual Regression] No story ID provided for baseline update');
      channel.emit(EVENTS.TEST_COMPLETE);
      return;
    }

    console.log('[Visual Regression] Preview: Starting baseline update for story:', storyId);
    channel.emit(EVENTS.TEST_STARTED);

    const storyName = getStoryNameFromId(storyId);
    console.log('[Visual Regression] Updating baseline for story:', storyId, storyName);

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

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const payload = line.slice(6);
                // Stream raw output to panel
                channel.emit(EVENTS.LOG_OUTPUT, payload);
                const eventData = JSON.parse(payload);
                console.log('[Visual Regression] Received event:', eventData.type, eventData);

                if (eventData.type === 'test-result') {
                  if (eventData.status === 'passed') {
                    console.log(`✅ Baseline Updated: ${eventData.title} [${eventData.storyId}]`);

                    // Remove from failed stories since baseline was updated
                    failedStories.delete(eventData.storyId);

                    // Emit test result to manager
                    channel.emit(EVENTS.TEST_RESULT, {
                      storyId: eventData.storyId,
                      storyName: eventData.title,
                      status: eventData.status,
                    });
                    // No sidebar highlight updates
                  } else if (eventData.status === 'failed') {
                    console.error(
                      `❌ Baseline Update Failed: ${eventData.title} [${eventData.storyId}]`,
                    );
                    if (eventData.error) {
                      console.error('   Error:', eventData.error);
                    }

                    // Emit test result to manager
                    channel.emit(EVENTS.TEST_RESULT, {
                      storyId: eventData.storyId,
                      storyName: eventData.title,
                      status: eventData.status,
                      error: eventData.error,
                    });
                  } else if (eventData.status === 'timedOut') {
                    console.warn(
                      `⚠️ Baseline Update Timed Out: ${eventData.title} [${eventData.storyId}]`,
                    );

                    // Emit test result to manager
                    channel.emit(EVENTS.TEST_RESULT, {
                      storyId: eventData.storyId,
                      storyName: eventData.title,
                      status: eventData.status,
                      error: eventData.error,
                    });
                  }
                } else if (eventData.type === 'complete') {
                  if (eventData.exitCode === 0 || eventData.exitCode === null) {
                    console.log('[Visual Regression] Baseline updated successfully');
                  } else {
                    console.log(
                      '[Visual Regression] Baseline update failed with exit code:',
                      eventData.exitCode,
                    );
                  }

                  // Emit failed stories to manager for highlighting
                  const failedStoryIds = Array.from(failedStories.keys());
                  channel.emit(EVENTS.HIGHLIGHT_FAILED_STORIES, failedStoryIds);

                  channel.emit(EVENTS.TEST_COMPLETE);
                } else if (eventData.type === 'error') {
                  console.error('[Visual Regression] Test error:', eventData.error);
                  channel.emit(EVENTS.TEST_COMPLETE);
                }
              } catch {
                console.warn('[Visual Regression] Failed to parse event:', line);
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      console.error('[Visual Regression] API call for baseline update failed:', error);
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
  // Example: "screens-basket--empty" -> "Screens / Basket ❯ Empty"
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
  return `${title}${name ? ` ❯ ${name}` : ''}`;
};

// Initialize the addon when the Storybook channel is ready
if (typeof window !== 'undefined') {
  initializeAddon();
}
