import React, { useEffect } from 'react';
import { useStorybookApi } from '@storybook/manager-api';
import { ScrollArea, Button } from '@storybook/components';
import { PlayIcon, SyncIcon, DownloadIcon, ChevronRightIcon, AddIcon } from '@storybook/icons';
import { EVENTS } from './constants';
import styles from './Panel.module.css';
import { useTestResults } from './TestResultsContext';
import type { TestResult } from './types';

// Helper function to get the addon server URL
const getAddonServerUrl = () => {
  const port = process.env.VR_ADDON_PORT || process.env.STORYBOOK_VISUAL_REGRESSION_PORT || '6007';
  return `http://localhost:${port}`;
};

type PanelProps = {
  active?: boolean;
};

export const Panel: React.FC<PanelProps> = ({ active = true }) => {
  const api = useStorybookApi();
  const { results, isRunning, isUpdating, logs, progress, cancelTest, clearLogs } =
    useTestResults();

  // Track current story ID to highlight failures for the current story
  const [currentStoryId, setCurrentStoryId] = React.useState<string | undefined>(
    api.getCurrentStoryData()?.id,
  );

  // Update current story ID when story changes
  useEffect(() => {
    const channel = api.getChannel();
    if (!channel) return;

    const handleStoryChanged = () => {
      const currentStory = api.getCurrentStoryData();
      setCurrentStoryId(currentStory?.id);
    };

    channel.on('storyChanged', handleStoryChanged);
    // Also check on mount and when results change
    handleStoryChanged();

    return () => {
      channel.off('storyChanged', handleStoryChanged);
    };
  }, [api, results]);

  // Check if channel is available - use state to track channel readiness
  const [channel, setChannel] = React.useState(api.getChannel());
  const isChannelReady = !!channel;

  // Update channel when it becomes available
  useEffect(() => {
    const currentChannel = api.getChannel();
    if (currentChannel !== channel) {
      console.log('[VR Addon Panel] Channel updated', { hasChannel: !!currentChannel });
      setChannel(currentChannel);
    }
  }, [api, channel]);

  const totalTests = results.length;
  const passedTests = results.filter((r) => r.status === 'passed').length;
  const failedTests = results.filter((r) => r.status === 'failed').length;
  const skippedTests = results.filter((r) => r.status === 'skipped').length;

  // Check if the current story has failed
  const currentStoryFailed = React.useMemo(() => {
    if (!currentStoryId) return false;
    return results.some((r) => {
      if (r.status !== 'failed') return false;
      // Exact match
      if (r.storyId === currentStoryId) return true;
      // Match without viewport suffix
      const baseResultId = r.storyId.replace(
        /--(unattended|attended|customer|mobile|tablet|desktop)$/,
        '',
      );
      return baseResultId === currentStoryId;
    });
  }, [results, currentStoryId]);

  const handleRunTest = () => {
    console.log('[VR Addon Panel] Test Current clicked', { isRunning, isUpdating, isChannelReady });
    if (isRunning || isUpdating) {
      console.log('[VR Addon Panel] Test already running or updating');
      return;
    }
    const currentStory = api.getCurrentStoryData();
    console.log('[VR Addon Panel] Current story:', currentStory?.id);
    if (currentStory) {
      const eventData = { storyId: currentStory.id };

      console.log('[VR Addon Panel] Starting test for story:', eventData.storyId);

      // Immediately show loading state by emitting TEST_STARTED
      if (channel) {
        console.log('[VR Addon Panel] Emitting TEST_STARTED to show loading...');
        channel.emit(EVENTS.TEST_STARTED);
      }

      // Send RPC request directly to the CLI via preset (delay slightly to let EventSource stabilize)
      console.log('[VR Addon Panel] Sending RPC request to run test...');
      setTimeout(() => {
        fetch(`${getAddonServerUrl()}/rpc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: Date.now(), // Unique ID
            method: 'run',
            params: {
              url: window.location.origin, // Storybook URL
              grep: `^${eventData.storyId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
            },
          }),
        })
          .then((response) => {
            console.log('[VR Addon Panel] RPC response status:', response.status);
            return response.json();
          })
          .then((data) => {
            console.log('[VR Addon Panel] RPC response:', data);
            if (data.error) {
              console.error('[VR Addon Panel] RPC error:', data.error);
              // Emit TEST_COMPLETE on error
              if (channel) {
                channel.emit(EVENTS.TEST_COMPLETE);
              }
            } else {
              console.log('[VR Addon Panel] Test completed, result:', data.result);
              // Emit TEST_COMPLETE now that we have the result
              if (channel) {
                channel.emit(EVENTS.TEST_COMPLETE);
              }

              // After test completes, reload all results to get the latest state
              // Wait a bit for the index to be updated
              setTimeout(async () => {
                console.log('[VR Addon Panel] Reloading results after test run...');
                // Emit a custom event to trigger result reload in preview
                if (channel) {
                  channel.emit('storybook-visual-regression/reload-results');
                }
              }, 500);
            }
          })
          .catch((err) => {
            console.error('[VR Addon Panel] Error sending RPC request:', err);
            // Emit TEST_COMPLETE on error
            if (channel) {
              channel.emit(EVENTS.TEST_COMPLETE);
            }
          });
      }, 1000); // Delay 1 second to let EventSource stabilize
    } else {
      console.log('[VR Addon Panel] No current story found');
    }
  };

  const handleRunAllTests = () => {
    console.log('[VR Addon Panel] Run All Tests clicked', {
      isRunning,
      isUpdating,
      isChannelReady,
    });
    if (isRunning || isUpdating) {
      console.log('[VR Addon Panel] Test already running or updating');
      return;
    }

    // Immediately show loading state by emitting TEST_STARTED
    if (channel) {
      console.log('[VR Addon Panel] Emitting TEST_STARTED to show loading...');
      channel.emit(EVENTS.TEST_STARTED);
    }

    // Send RPC request directly to the CLI via preset (delay slightly to let EventSource stabilize)
    console.log('[VR Addon Panel] Sending RPC request to run all tests...');
    setTimeout(() => {
      fetch(`${getAddonServerUrl()}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(), // Unique ID
          method: 'run',
          params: {
            url: window.location.origin, // Storybook URL
            grep: '', // Empty grep to run all tests
            outputDir: `/tmp/storybook-visual-regression-${Date.now()}`, // Use temp directory
          },
        }),
      })
        .then((response) => {
          console.log('[VR Addon Panel] RPC response status:', response.status);
          return response.json();
        })
        .then((data) => {
          console.log('[VR Addon Panel] RPC response:', data);
          if (data.error) {
            console.error('[VR Addon Panel] RPC error:', data.error);
            // Emit TEST_COMPLETE on error
            if (channel) {
              channel.emit(EVENTS.TEST_COMPLETE);
            }
          } else {
            console.log('[VR Addon Panel] All tests completed, result:', data.result);
            // Emit TEST_COMPLETE now that we have the result
            if (channel) {
              channel.emit(EVENTS.TEST_COMPLETE);
            }
          }
        })
        .catch((err) => {
          console.error('[VR Addon Panel] Error sending RPC request:', err);
          // Emit TEST_COMPLETE on error
          if (channel) {
            channel.emit(EVENTS.TEST_COMPLETE);
          }
        });
    }, 1000); // Delay 1 second to let EventSource stabilize
  };

  const handleRunFailedTests = () => {
    console.log('[VR Addon Panel] Run Failed Tests clicked', { isChannelReady });
    if (!isChannelReady || !channel) {
      console.error('[VR Addon Panel] Channel not ready');
      return;
    }
    if (isRunning || isUpdating) {
      console.log('[VR Addon Panel] Test already running or updating');
      return;
    }
    try {
      channel.emit(EVENTS.RUN_FAILED_TESTS, {});
      console.log('[VR Addon Panel] RUN_FAILED_TESTS event emitted via channel');
      // Also send via HTTP to ensure preview receives it
      fetch(`${getAddonServerUrl()}/emit-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: EVENTS.RUN_FAILED_TESTS, data: {} }),
      }).catch((err) => {
        console.error('[VR Addon Panel] Error sending RUN_FAILED_TESTS via HTTP:', err);
      });
    } catch (error) {
      console.error('[VR Addon Panel] Error emitting RUN_FAILED_TESTS:', error);
    }
  };

  const handleUpdateBaseline = () => {
    console.log('[VR Addon Panel] Update Baseline clicked', { isChannelReady });
    if (!isChannelReady || !channel) {
      console.error('[VR Addon Panel] Channel not ready');
      return;
    }
    if (isRunning || isUpdating) {
      console.log('[VR Addon Panel] Test already running or updating');
      return;
    }
    const currentStory = api.getCurrentStoryData();
    console.log('[VR Addon Panel] Current story:', currentStory?.id);
    if (currentStory) {
      console.log('[VR Addon Panel] Starting baseline update for story:', currentStory.id);

      // Immediately show loading state by emitting UPDATE_STARTED
      channel.emit(EVENTS.UPDATE_STARTED);
      console.log('[VR Addon Panel] Emitting UPDATE_STARTED to show loading...');

      // Send RPC request directly to the CLI via preset
      console.log('[VR Addon Panel] Sending RPC request to update baseline...');
      setTimeout(() => {
        fetch(`${getAddonServerUrl()}/rpc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: Date.now(), // Unique ID
            method: 'run',
            params: {
              url: window.location.origin, // Storybook URL
              update: true, // This tells the CLI to update/create baselines
              grep: `^${currentStory.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
            },
          }),
        })
          .then((response) => {
            console.log('[VR Addon Panel] RPC response status:', response.status);
            return response.json();
          })
          .then((data) => {
            console.log('[VR Addon Panel] RPC response:', data);
            if (data.error) {
              console.error('[VR Addon Panel] RPC error:', data.error);
              // Emit TEST_COMPLETE on error (since we're done with the update)
              if (channel) {
                channel.emit(EVENTS.TEST_COMPLETE);
              }
            } else {
              console.log('[VR Addon Panel] Baseline update completed, result:', data.result);
              // Emit TEST_COMPLETE to hide loading (baseline updates use the same UI state)
              if (channel) {
                channel.emit(EVENTS.TEST_COMPLETE);
              }

              // After update completes, reload all results to get the latest state
              // Wait a bit for the index to be updated
              setTimeout(async () => {
                console.log('[VR Addon Panel] Reloading results after baseline update...');
                // Emit a custom event to trigger result reload in preview
                if (channel) {
                  channel.emit('storybook-visual-regression/reload-results');
                }
              }, 500);
            }
          })
          .catch((err) => {
            console.error('[VR Addon Panel] Error sending RPC request:', err);
            // Emit TEST_COMPLETE on error
            if (channel) {
              channel.emit(EVENTS.TEST_COMPLETE);
            }
          });
      }, 1000); // Delay 1 second to let EventSource stabilize
    } else {
      console.log('[VR Addon Panel] No current story found');
    }
  };

  const handleCreateMissingSnapshots = () => {
    console.log('[VR Addon Panel] Create Missing Snapshots clicked', { isChannelReady });
    if (!isChannelReady || !channel) {
      console.error('[VR Addon Panel] Channel not ready');
      return;
    }
    if (isRunning || isUpdating) {
      console.log('[VR Addon Panel] Test already running or updating');
      return;
    }

    console.log('[VR Addon Panel] Starting create missing snapshots...');

    // Immediately show loading state by emitting UPDATE_STARTED
    channel.emit(EVENTS.UPDATE_STARTED);
    console.log('[VR Addon Panel] Emitting UPDATE_STARTED to show loading...');

    // Send RPC request directly to the CLI via preset
    console.log('[VR Addon Panel] Sending RPC request to create missing snapshots...');
    setTimeout(() => {
      fetch(`${getAddonServerUrl()}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(), // Unique ID
          method: 'run',
          params: {
            url: window.location.origin, // Storybook URL
            missingOnly: true, // This tells the CLI to only create missing baselines
          },
        }),
      })
        .then((response) => {
          console.log('[VR Addon Panel] RPC response status:', response.status);
          return response.json();
        })
        .then((data) => {
          console.log('[VR Addon Panel] RPC response:', data);
          if (data.error) {
            console.error('[VR Addon Panel] RPC error:', data.error);
            // Emit TEST_COMPLETE on error
            if (channel) {
              channel.emit(EVENTS.TEST_COMPLETE);
            }
          } else {
            console.log(
              '[VR Addon Panel] Create missing snapshots completed, result:',
              data.result,
            );
            // Emit TEST_COMPLETE to hide loading
            if (channel) {
              channel.emit(EVENTS.TEST_COMPLETE);
            }

            // After create missing completes, reload all results to get the latest state
            // Wait a bit for the index to be updated
            setTimeout(async () => {
              console.log('[VR Addon Panel] Reloading results after create missing...');
              // Emit a custom event to trigger result reload in preview
              if (channel) {
                channel.emit('storybook-visual-regression/reload-results');
              }
            }, 500);
          }
        })
        .catch((err) => {
          console.error('[VR Addon Panel] Error sending RPC request:', err);
          // Emit TEST_COMPLETE on error
          if (channel) {
            channel.emit(EVENTS.TEST_COMPLETE);
          }
        });
    }, 1000); // Delay 1 second to let EventSource stabilize
  };

  const handleCancelTest = () => {
    console.log('[VR Addon Panel] Cancel clicked', { isChannelReady });
    if (!isChannelReady || !channel) {
      console.error('[VR Addon Panel] Channel not ready');
      return;
    }
    try {
      cancelTest();
      channel.emit(EVENTS.CANCEL_TEST);
      console.log('[VR Addon Panel] CANCEL_TEST event emitted via channel');
      // Also send via HTTP to ensure preview receives it
      fetch(`${getAddonServerUrl()}/emit-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: EVENTS.CANCEL_TEST, data: {} }),
      }).catch((err) => {
        console.error('[VR Addon Panel] Error sending CANCEL_TEST via HTTP:', err);
      });
    } catch (error) {
      console.error('[VR Addon Panel] Error emitting CANCEL_TEST:', error);
    }
  };

  const handleNextFailedTest = () => {
    if (!isChannelReady || !channel) {
      return;
    }
    const failedResults = results.filter((r) => r.status === 'failed');
    if (failedResults.length === 0) {
      return;
    }

    const currentStory = api.getCurrentStoryData();
    const currentStoryId = currentStory?.id;

    // Find the index of the current story in the failed results list
    let currentIndex = -1;
    if (currentStoryId) {
      // Try exact match first
      currentIndex = failedResults.findIndex((r) => {
        // Remove viewport suffix for comparison
        const baseResultId = r.storyId.replace(
          /--(unattended|attended|customer|mobile|tablet|desktop)$/,
          '',
        );
        return baseResultId === currentStoryId || r.storyId === currentStoryId;
      });
    }

    // Get the next failed test (cycle to first if at the end)
    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % failedResults.length : 0;
    const nextResult = failedResults[nextIndex];

    // Remove viewport suffix from story ID for navigation
    let baseStoryId = nextResult.storyId;
    baseStoryId = baseStoryId.replace(
      /--(unattended|attended|customer|mobile|tablet|desktop)$/,
      '',
    );

    // Navigate to the story
    try {
      api.selectStory(baseStoryId);
      // Show diff after navigation completes
      setTimeout(() => {
        if (nextResult.diffPath || nextResult.errorPath) {
          showDiffInIframe(nextResult);
        }
      }, 800);
    } catch (error) {
      console.error('[VR Addon] Failed to navigate to story:', error);
      // Still try to show the diff even if navigation fails
      if (nextResult.diffPath || nextResult.errorPath) {
        showDiffInIframe(nextResult);
      }
    }
  };

  const showDiffInIframe = (result: {
    storyId: string;
    storyName?: string;
    diffPath?: string;
    errorPath?: string;
    errorType?: string;
  }) => {
    const imagePath = result.diffPath || result.errorPath;
    if (!imagePath) return;

    const iframe = document.getElementById('storybook-preview-iframe') as HTMLIFrameElement;
    if (!iframe) return;

    // Build URL - we'll need to serve images via the RPC server
    // For now, use a data URL or serve via the minimal HTTP server
    let relativePath = imagePath;
    const visualRegressionIndex = imagePath.indexOf('/visual-regression/');
    if (visualRegressionIndex !== -1) {
      relativePath = imagePath.substring(visualRegressionIndex + '/visual-regression/'.length);
    }
    const imageUrl = `${getAddonServerUrl()}/image/${encodeURIComponent(relativePath)}`;

    // Determine the title and styling based on error type
    let title = `diff image for ${result.storyName || result.storyId}`;
    let backgroundColor = '#0b1020';

    if (result.errorPath) {
      switch (result.errorType) {
        case 'loading_failure':
          title = `Error screenshot for ${result.storyName || result.storyId} (Loading Failure)`;
          backgroundColor = '#2d1b1b';
          break;
        case 'network_error':
          title = `Error screenshot for ${result.storyName || result.storyId} (Network Error)`;
          backgroundColor = '#1b2d2d';
          break;
        default:
          title = `Error screenshot for ${result.storyName || result.storyId}`;
          backgroundColor = '#2d2d1b';
          break;
      }
    }

    const htmlContent = `<!DOCTYPE html><html><head><style>
      body{margin:0;padding:0;background:${backgroundColor};display:flex;justify-content:center;align-items:center;min-height:100vh}
      img{max-width:100%;max-height:100vh;object-fit:contain}
      .error-label{position:absolute;top:10px;left:10px;background:rgba(0,0,0,0.7);color:white;padding:5px 10px;border-radius:3px;font-family:monospace;font-size:12px}
    </style></head><body>
      ${result.errorPath ? '<div class="error-label">ERROR SCREENSHOT</div>' : ''}
      <img src="${imageUrl}" alt="${title}"/>
    </body></html>`;

    iframe.srcdoc = htmlContent;

    // Emit event to notify Tool component that diff/error is being shown
    if (channel) {
      channel.emit(EVENTS.DIFF_SHOWN, {
        storyId: result.storyId,
        type: result.errorPath ? 'error' : 'diff',
      });
    }
  };

  // Get latest log messages for display (last 10)
  const recentLogs = logs.slice(-10);

  // Automatically show diff image when current story's test fails
  // Use a ref to track if we've already shown the diff for this result to avoid showing it multiple times
  const shownDiffRef = React.useRef<Set<string>>(new Set());

  useEffect(() => {
    // Only show diff when test completes (not running) and we have results
    if (!isRunning && results.length > 0) {
      const currentStory = api.getCurrentStoryData();
      if (currentStory) {
        // Find failed result for current story (exact match or without viewport suffix)
        const baseStoryId = currentStory.id;
        const failedResult = results.find((r) => {
          if (r.status !== 'failed') return false;
          // Exact match
          if (r.storyId === baseStoryId) return true;
          // Match without viewport suffix
          const baseResultId = r.storyId.replace(
            /--(unattended|attended|customer|mobile|tablet|desktop)$/,
            '',
          );
          return baseResultId === baseStoryId;
        });

        if (failedResult && (failedResult.diffPath || failedResult.errorPath)) {
          // Create a unique key for this result to avoid showing it multiple times
          const resultKey = `${failedResult.storyId}-${failedResult.diffPath || failedResult.errorPath}`;

          if (!shownDiffRef.current.has(resultKey)) {
            shownDiffRef.current.add(resultKey);
            // Small delay to ensure iframe is ready and test has fully completed
            const timeoutId = setTimeout(() => {
              showDiffInIframe(failedResult);
            }, 500);

            return () => clearTimeout(timeoutId);
          }
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, isRunning]);

  // Clear shown diffs when a new test starts
  useEffect(() => {
    if (isRunning) {
      shownDiffRef.current.clear();
    }
  }, [isRunning]);

  // Function to restore iframe (hide diff image)
  const restoreIframe = React.useCallback(() => {
    // Try multiple ways to find the iframe
    let iframe = document.getElementById('storybook-preview-iframe') as HTMLIFrameElement;
    if (!iframe) {
      // Try querySelector as fallback
      iframe = document.querySelector(
        'iframe[title*="story"], iframe[title*="Story"]',
      ) as HTMLIFrameElement;
    }
    if (!iframe) {
      // Try finding iframe in the manager window
      const managerWindow = window.parent || window;
      iframe = managerWindow.document?.getElementById(
        'storybook-preview-iframe',
      ) as HTMLIFrameElement;
    }

    if (iframe && iframe.hasAttribute('srcdoc')) {
      iframe.removeAttribute('srcdoc');
      console.log('[VR Addon] Restored iframe - diff image hidden');
    }
    // Clear shown diffs so they can be shown again for the new story if needed
    shownDiffRef.current.clear();
  }, []);

  // Hide diff image when story changes
  useEffect(() => {
    const channel = api.getChannel();
    if (!channel) return;

    const handleStoryChanged = () => {
      console.log('[VR Addon] Story changed event received');
      restoreIframe();
    };

    // Also listen for storyRendered as a backup
    const handleStoryRendered = () => {
      console.log('[VR Addon] Story rendered event received');
      // Small delay to ensure story is fully loaded before checking
      setTimeout(() => {
        restoreIframe();
      }, 100);
    };

    channel.on('storyChanged', handleStoryChanged);
    channel.on('storyRendered', handleStoryRendered);

    return () => {
      channel.off('storyChanged', handleStoryChanged);
      channel.off('storyRendered', handleStoryRendered);
    };
  }, [api, restoreIframe]);

  // Also restore iframe when clicking on failed test links
  // This ensures the diff is hidden immediately when navigating
  const handleClickWithRestore = React.useCallback(
    (e: React.MouseEvent, result: TestResult) => {
      e.preventDefault();
      e.stopPropagation();

      // Hide diff immediately when clicking
      restoreIframe();

      console.log('[VR Addon] Clicked on failed test:', result.storyId, {
        diffPath: result.diffPath,
        errorPath: result.errorPath,
      });

      // Remove viewport suffix from story ID for navigation
      let baseStoryId = result.storyId;
      baseStoryId = baseStoryId.replace(
        /--(unattended|attended|customer|mobile|tablet|desktop)$/,
        '',
      );

      // Navigate to the story
      try {
        // Use selectStory to navigate (this is the standard Storybook API method)
        api.selectStory(baseStoryId);
        console.log('[VR Addon] Navigated to story:', baseStoryId);

        // Show diff after navigation completes (if available)
        // Use a longer delay to ensure Storybook has navigated
        setTimeout(() => {
          if (result.diffPath || result.errorPath) {
            showDiffInIframe(result);
          } else {
            console.log(
              '[VR Addon] No diff or error image available for this test - just navigated to story',
            );
          }
        }, 800);
      } catch (error) {
        console.error('[VR Addon] Failed to navigate to story:', error);
        // Still try to show the diff even if navigation fails
        if (result.diffPath || result.errorPath) {
          showDiffInIframe(result);
        }
      }
    },
    [api, restoreIframe],
  );

  return (
    <>
      {!active && null}
      {active && (
        <>
          {/* Running state with progress */}
          {(isRunning || isUpdating) && (
            <div className={styles.runningContainer}>
              <div className={styles.progressBar}>
                <div
                  className={styles.progressFill}
                  style={{
                    width: progress
                      ? `${progress.percent || Math.round((progress.completed / progress.total) * 100)}%`
                      : '0%',
                  }}
                />
              </div>
              <div className={styles.runningContent}>
                <div className={styles.spinner} />
                <div className={styles.runningText}>
                  <strong>{isUpdating ? 'Updating snapshot...' : 'Running tests...'}</strong>
                  {progress && (
                    <div className={styles.progressStats}>
                      <span className={styles.progressStat}>
                        Stories: {progress.completed}/{progress.total}
                        {progress.storiesPerMinute !== undefined &&
                          ` ${progress.storiesPerMinute}/m`}
                        {progress.percent !== undefined && ` ${progress.percent}%`}
                      </span>
                      {progress.timeRemainingFormatted && (
                        <span className={styles.progressStat}>
                          Remaining: ~{progress.timeRemainingFormatted}
                        </span>
                      )}
                      {progress.workers !== undefined && (
                        <span className={styles.progressStat}>Workers: {progress.workers}</span>
                      )}
                      {progress.cpuUsage !== undefined && (
                        <span
                          className={`${styles.progressStat} ${
                            progress.cpuUsage < 50
                              ? styles.cpuLow
                              : progress.cpuUsage < 90
                                ? styles.cpuMedium
                                : styles.cpuHigh
                          }`}
                        >
                          CPU: {progress.cpuUsage.toFixed(0)}%
                        </span>
                      )}
                    </div>
                  )}
                  {recentLogs.length > 0 && (
                    <div className={styles.logPreview}>
                      {recentLogs.map((log, idx) => (
                        <div key={idx} className={styles.logLine}>
                          {log}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <Button onClick={handleCancelTest} className={styles.cancelButtonInline}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {/* Main content */}
          <ScrollArea vertical>
            <div className={styles.section}>
              {/* All buttons in one row */}
              <div className={styles.buttonsRow}>
                <Button
                  onClick={handleRunAllTests}
                  disabled={isRunning || isUpdating || !isChannelReady}
                  title="Run visual regression tests for all stories"
                >
                  <SyncIcon className={styles.buttonIcon} />
                  Test All
                </Button>
                {failedTests > 1 && (
                  <Button
                    onClick={handleNextFailedTest}
                    disabled={isRunning || isUpdating || !isChannelReady}
                    title="Navigate to next failed test"
                  >
                    <ChevronRightIcon className={styles.buttonIcon} />
                    Next Failed
                  </Button>
                )}
                {failedTests > 0 && (
                  <Button
                    onClick={handleRunFailedTests}
                    disabled={isRunning || isUpdating || !isChannelReady}
                    title="Run visual regression tests for failed stories only"
                  >
                    <SyncIcon className={styles.buttonIcon} />
                    Test Failed
                  </Button>
                )}
                {!isRunning && !isUpdating && (
                  <>
                    <Button
                      onClick={handleRunTest}
                      disabled={isRunning || isUpdating || !isChannelReady}
                      title="Run visual regression test for the current story"
                    >
                      <PlayIcon className={styles.buttonIcon} />
                      Test Current
                    </Button>
                    <Button
                      onClick={handleUpdateBaseline}
                      disabled={isRunning || isUpdating || !isChannelReady || !currentStoryFailed}
                      title="Update baseline snapshot for the current story"
                    >
                      <DownloadIcon className={styles.buttonIcon} />
                      Update Snapshot
                    </Button>
                    <Button
                      onClick={handleCreateMissingSnapshots}
                      disabled={isRunning || isUpdating || !isChannelReady || skippedTests === 0}
                      title="Create baseline snapshots for stories that don't have them"
                    >
                      <AddIcon className={styles.buttonIcon} />
                      Create Missing
                    </Button>
                  </>
                )}
              </div>

              {/* Results Summary */}
              {results.length > 0 && (
                <div className={styles.resultsSection}>
                  <div className={styles.counts}>
                    <span className={styles.count}>Total: {totalTests}</span>
                    <span className={`${styles.count} ${styles.countPassed}`}>
                      Passed: {passedTests}
                    </span>
                    <span className={`${styles.count} ${styles.countFailed}`}>
                      Failed: {failedTests}
                    </span>
                    {skippedTests > 0 && (
                      <span className={styles.count}>Skipped: {skippedTests}</span>
                    )}
                  </div>
                </div>
              )}

              {/* Show message when no test results */}
              {results.length === 0 && (
                <div className={styles.noResults}>
                  <p>No test results yet.</p>
                  <p>
                    Click "Test Current" to test the current story, or "Test All" to run all visual
                    regression tests.
                  </p>
                </div>
              )}

              {/* Failed Tests Table */}
              {results.some((r) => r.status === 'failed') && (
                <div>
                  <table className={styles.failuresTable}>
                    <thead>
                      <tr>
                        <th className={styles.tableHeader}>Story</th>
                        <th className={styles.tableHeader}>Difference</th>
                        <th className={styles.tableHeader}>Failure</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(() => {
                        return results
                          .filter((r) => r.status === 'failed')
                          .map((result) => {
                            // Remove viewport suffix from story ID for navigation
                            // Try to extract the base story ID (component--story format)
                            let baseStoryId = result.storyId;

                            // Remove common viewport suffixes
                            baseStoryId = baseStoryId.replace(
                              /--(unattended|attended|customer|mobile|tablet|desktop)$/,
                              '',
                            );

                            // Check if this failure is for the current story
                            const isCurrentStory =
                              currentStoryId &&
                              (baseStoryId === currentStoryId || result.storyId === currentStoryId);

                            // If the story ID still has multiple parts, use it as-is
                            // Storybook should handle the full story ID

                            const handleClick = (e: React.MouseEvent) => {
                              e.preventDefault();
                              e.stopPropagation();

                              console.log('[VR Addon] Clicked on failed test:', result.storyId, {
                                diffPath: result.diffPath,
                                errorPath: result.errorPath,
                                baseStoryId,
                              });

                              // Navigate to the story
                              try {
                                // Use selectStory to navigate (this is the standard Storybook API method)
                                api.selectStory(baseStoryId);
                                console.log('[VR Addon] Navigated to story:', baseStoryId);

                                // Show diff after navigation completes (if available)
                                // Use a longer delay to ensure Storybook has navigated
                                setTimeout(() => {
                                  if (result.diffPath || result.errorPath) {
                                    showDiffInIframe(result);
                                  } else {
                                    console.log(
                                      '[VR Addon] No diff or error image available for this test - just navigated to story',
                                    );
                                  }
                                }, 800);
                              } catch (error) {
                                console.error('[VR Addon] Failed to navigate to story:', error);
                                // Still try to show the diff even if navigation fails
                                if (result.diffPath || result.errorPath) {
                                  showDiffInIframe(result);
                                }
                              }
                            };

                            // Get failure reason text
                            const getFailureReason = () => {
                              // Use errorType for simple failure reasons
                              if (result.errorType) {
                                switch (result.errorType) {
                                  case 'screenshot_mismatch':
                                    return 'Screenshot mismatch';
                                  case 'loading_failure':
                                    return 'Loading failure';
                                  case 'network_error':
                                    return 'Network error';
                                  case 'other_error':
                                    return 'Other error';
                                  default:
                                    return 'Failed';
                                }
                              }

                              // Fallback to generic failed status
                              return 'Failed';
                            };

                            const failureReason = getFailureReason();

                            // Build difference info
                            const diffInfo = [];
                            if (result.diffPixels !== undefined) {
                              diffInfo.push(`${result.diffPixels.toLocaleString()} pixels`);
                            }
                            if (result.diffPercent !== undefined) {
                              diffInfo.push(`${result.diffPercent.toFixed(2)}%`);
                            }
                            const differenceText = diffInfo.join(', ') || '-';

                            return (
                              <tr
                                key={result.storyId}
                                className={`${styles.failureRow} ${
                                  isCurrentStory ? styles.failureRowCurrent : ''
                                }`}
                              >
                                <td className={styles.tableCell}>
                                  <button
                                    onClick={(e) => handleClickWithRestore(e, result)}
                                    className={`${styles.linkButton} ${
                                      isCurrentStory ? styles.linkButtonCurrent : ''
                                    }`}
                                    title={
                                      result.errorPath
                                        ? `Error: ${result.error || 'Story failed to load'}`
                                        : result.diffPath
                                          ? 'View diff image'
                                          : 'Navigate to story'
                                    }
                                  >
                                    {result.storyName || result.storyId}
                                  </button>
                                </td>
                                <td className={styles.tableCell}>
                                  <span className={styles.diffInfo}>{differenceText}</span>
                                </td>
                                <td className={styles.tableCell}>
                                  <span className={styles.failureReason}>
                                    {failureReason || '-'}
                                  </span>
                                </td>
                              </tr>
                            );
                          });
                      })()}
                    </tbody>
                  </table>
                </div>
              )}

              {/* All Passed Message */}
              {results.length > 0 && failedTests === 0 && (
                <div className={styles.allPassed}>
                  <p>✓ All tests passed!</p>
                </div>
              )}
            </div>
          </ScrollArea>
        </>
      )}
    </>
  );
};
