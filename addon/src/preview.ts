/**
 * Preview-side code for the Visual Regression addon.
 *
 * This runs in the browser and communicates with the API server
 * started by the addon preset (which runs in Node.js).
 */

import { EVENTS } from './constants';

const API_BASE_URL = 'http://localhost:6007';

// Try to get the addons channel from the global window object
// This is how Storybook addons communicate between manager and preview
const getChannel = () => {
  if (typeof window !== 'undefined' && (window as any).__STORYBOOK_ADDONS_CHANNEL__) {
    return (window as any).__STORYBOOK_ADDONS_CHANNEL__;
  }
  return null;
};

// Track failed stories and their diff information
const failedStories: Map<string, any> = new Map();

// Initialize the addon by setting up event listeners
const initializeAddon = async () => {
  const channel = getChannel();

  if (!channel) {
    console.warn('[Visual Regression Addon] Channel not available');
    return;
  }

  console.log('[Visual Regression Addon] Initialized - API Server running on port 6007');

  // Load existing failed test results on initialization
  try {
    const response = await fetch(`${API_BASE_URL}/get-failed-results`);
    if (response.ok) {
      const failedResults = await response.json();
      console.log('[Visual Regression] Loaded existing failed results:', failedResults);

      // Populate failedStories map with existing results
      failedResults.forEach((result: any) => {
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

      // Emit failed stories for highlighting
      const failedStoryIds = Array.from(failedStories.keys());
      console.log('[Visual Regression] Emitting existing failed stories:', failedStoryIds);
      channel.emit(EVENTS.HIGHLIGHT_FAILED_STORIES, failedStoryIds);
    }
  } catch (error) {
    console.warn('[Visual Regression] Could not load existing failed results:', error);
  }

  // Stop any running tests when the page is about to reload/unload
  const stopRunningTests = async () => {
    try {
      await fetch(`${API_BASE_URL}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      console.log('[Visual Regression] Stopped running tests due to page reload');
    } catch (error) {
      // Silent fail - page is reloading anyway
    }
  };

  // Listen for page unload/reload events
  window.addEventListener('beforeunload', stopRunningTests);
  window.addEventListener('unload', stopRunningTests);

  // Listen for story changes to show/hide diff overlay
  channel.on('storyChanged', (storyId: string) => {
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
  channel.on(EVENTS.RUN_TEST, async (data: { storyId?: string }) => {
    const storyId = data.storyId;
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
                const eventData = JSON.parse(line.slice(6));
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

                  // Emit failed stories to manager for highlighting
                  const failedStoryIds = Array.from(failedStories.keys());
                  channel.emit(EVENTS.HIGHLIGHT_FAILED_STORIES, failedStoryIds);

                  channel.emit(EVENTS.TEST_COMPLETE);
                } else if (eventData.type === 'error') {
                  console.error('[Visual Regression] Test error:', eventData.error);
                  channel.emit(EVENTS.TEST_COMPLETE);
                }
              } catch (parseError) {
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
                const eventData = JSON.parse(line.slice(6));
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
                      storyId: eventData.storyId,
                      storyName: eventData.title,
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
              } catch (parseError) {
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
  channel.on(EVENTS.UPDATE_BASELINE, async (data: { storyId?: string }) => {
    const storyId = data.storyId;
    if (!storyId) {
      console.error('[Visual Regression] No story ID provided for baseline update');
      channel.emit(EVENTS.TEST_COMPLETE);
      return;
    }

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
                const eventData = JSON.parse(line.slice(6));
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
              } catch (parseError) {
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
