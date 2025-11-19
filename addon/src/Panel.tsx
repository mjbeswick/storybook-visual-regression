import React, { useEffect } from 'react';
import { useStorybookApi } from '@storybook/manager-api';
import { ScrollArea, Button } from '@storybook/components';
import { PlayIcon, SyncIcon, DownloadIcon, ChevronRightIcon, AddIcon } from '@storybook/icons';
import { EVENTS } from './constants';
import styles from './Panel.module.css';
import { useTestResults } from './TestResultsContext';
import type { TestResult } from './types';

type PanelProps = {
  active?: boolean;
};

export const Panel: React.FC<PanelProps> = ({ active = true }) => {
  const api = useStorybookApi();
  const { results, isRunning, isUpdating, logs, progress, cancelTest, clearLogs } = useTestResults();

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

  const handleRunTest = () => {
    console.log('[VR Addon Panel] Test Current clicked', { isRunning, isUpdating, isChannelReady });
    if (!isChannelReady || !channel) {
      console.error('[VR Addon Panel] Channel not ready', { channel: !!channel, isChannelReady });
      return;
    }
    if (isRunning || isUpdating) {
      console.log('[VR Addon Panel] Test already running or updating');
      return;
    }
    const currentStory = api.getCurrentStoryData();
    console.log('[VR Addon Panel] Current story:', currentStory?.id);
    if (currentStory) {
      console.log('[VR Addon Panel] Emitting RUN_TEST event via channel', EVENTS.RUN_TEST);
      try {
        channel.emit(EVENTS.RUN_TEST, { storyId: currentStory.id });
        console.log('[VR Addon Panel] Event emitted via channel');
        // Also send via HTTP to ensure preview receives it
        fetch('http://localhost:6007/emit-event', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: EVENTS.RUN_TEST, data: { storyId: currentStory.id } }),
        }).catch((err) => {
          console.error('[VR Addon Panel] Error sending event via HTTP:', err);
        });
      } catch (error) {
        console.error('[VR Addon Panel] Error emitting event:', error);
      }
    } else {
      console.log('[VR Addon Panel] No current story found');
    }
  };

  const handleRunAllTests = () => {
    console.log('[VR Addon Panel] Run All Tests clicked', { isChannelReady });
    if (!isChannelReady || !channel) {
      console.error('[VR Addon Panel] Channel not ready');
      return;
    }
    if (isRunning || isUpdating) {
      console.log('[VR Addon Panel] Test already running or updating');
      return;
    }
    try {
      channel.emit(EVENTS.RUN_ALL_TESTS, {});
      console.log('[VR Addon Panel] RUN_ALL_TESTS event emitted via channel');
      // Also send via HTTP to ensure preview receives it
      fetch('http://localhost:6007/emit-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: EVENTS.RUN_ALL_TESTS, data: {} }),
      }).catch((err) => {
        console.error('[VR Addon Panel] Error sending RUN_ALL_TESTS via HTTP:', err);
      });
    } catch (error) {
      console.error('[VR Addon Panel] Error emitting RUN_ALL_TESTS:', error);
    }
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
      fetch('http://localhost:6007/emit-event', {
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
      try {
        channel.emit(EVENTS.UPDATE_BASELINE, { storyId: currentStory.id });
        console.log('[VR Addon Panel] UPDATE_BASELINE event emitted via channel');
        // Also send via HTTP to ensure preview receives it
        fetch('http://localhost:6007/emit-event', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: EVENTS.UPDATE_BASELINE, data: { storyId: currentStory.id } }),
        }).catch((err) => {
          console.error('[VR Addon Panel] Error sending UPDATE_BASELINE via HTTP:', err);
        });
      } catch (error) {
        console.error('[VR Addon Panel] Error emitting UPDATE_BASELINE:', error);
      }
    } else {
      console.log('[VR Addon Panel] No current story found');
    }
  };

  const handleCreateMissingSnapshots = () => {
    if (!isChannelReady || !channel) {
      return;
    }
    try {
      channel.emit(EVENTS.CREATE_MISSING_SNAPSHOTS, {});
      console.log('[VR Addon Panel] CREATE_MISSING_SNAPSHOTS event emitted via channel');
      // Also send via HTTP to ensure preview receives it
      fetch('http://localhost:6007/emit-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: EVENTS.CREATE_MISSING_SNAPSHOTS, data: {} }),
      }).catch((err) => {
        console.error('[VR Addon Panel] Error sending CREATE_MISSING_SNAPSHOTS via HTTP:', err);
      });
    } catch (error) {
      console.error('[VR Addon Panel] Error emitting CREATE_MISSING_SNAPSHOTS:', error);
    }
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
      fetch('http://localhost:6007/emit-event', {
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
    const imageUrl = `http://localhost:6007/image/${encodeURIComponent(relativePath)}`;

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
                        {progress.storiesPerMinute !== undefined && ` ${progress.storiesPerMinute}/m`}
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

          {/* Main content when not running */}
          {!isRunning && !isUpdating && (
            <ScrollArea vertical>
              <div className={styles.section}>
                <div className={styles.buttonsRow}>
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
                    disabled={isRunning || isUpdating || !isChannelReady}
                    title="Update baseline snapshot for the current story"
                  >
                    <DownloadIcon className={styles.buttonIcon} />
                    Update Snapshot
                  </Button>
                  <Button
                    onClick={handleCreateMissingSnapshots}
                    disabled={isRunning || isUpdating || !isChannelReady}
                    title="Create baseline snapshots for stories that don't have them"
                  >
                    <AddIcon className={styles.buttonIcon} />
                    Create Missing
                  </Button>
                  <Button
                    onClick={handleRunAllTests}
                    disabled={isRunning || isUpdating || !isChannelReady}
                    title="Run visual regression tests for all stories"
                  >
                    <SyncIcon className={styles.buttonIcon} />
                    Test All
                  </Button>
                  {failedTests > 0 && (
                    <>
                      <Button
                        onClick={handleRunFailedTests}
                        disabled={isRunning || isUpdating || !isChannelReady}
                        title="Run visual regression tests for failed stories only"
                      >
                        <SyncIcon className={styles.buttonIcon} />
                        Test Failed
                      </Button>
                      <Button
                        onClick={handleNextFailedTest}
                        disabled={isRunning || isUpdating || !isChannelReady}
                        title="Navigate to next failed test"
                      >
                        <ChevronRightIcon className={styles.buttonIcon} />
                        Next Failed
                      </Button>
                    </>
                  )}
                </div>

                {/* Results Summary */}
                {results.length > 0 && (
                  <div className={styles.resultsSection}>
                    <h4>Test Results</h4>
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
                      Click "Test Current" to test the current story, or "Test All" to run all
                      visual regression tests.
                    </p>
                  </div>
                )}

                {/* Failed Tests List */}
                {results.some((r) => r.status === 'failed') && (
                  <div className={styles.failuresSection}>
                    <h4>Failed Tests</h4>
                    <ul className={styles.failuresList}>
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
                              // Prefer the error message if available (it has more detail)
                              if (result.error) {
                                // Remove "Screenshot mismatch" prefix if present
                                return result.error.replace(
                                  /^Screenshot mismatch\s*[-–—]?\s*/i,
                                  '',
                                );
                              }

                              // Fall back to errorType if no error message
                              if (result.errorType) {
                                switch (result.errorType) {
                                  case 'screenshot_mismatch':
                                    // Don't show "Screenshot mismatch" - just show if diff is missing
                                    return result.diffPath ? '' : '(no diff image)';
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

                              // Last resort: infer from available data
                              if (result.diffPath) {
                                return '';
                              }

                              return 'Failed';
                            };

                            const failureReason = getFailureReason();

                            return (
                              <li
                                key={result.storyId}
                                className={`${styles.failureItem} ${
                                  isCurrentStory ? styles.failureItemCurrent : ''
                                }`}
                              >
                                <div className={styles.failureContent}>
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
                                    <span className={styles.failureName}>
                                      {result.storyName || result.storyId}
                                    </span>
                                  </button>
                                  <div className={styles.failureDetails}>
                                    {result.diffPixels !== undefined && (
                                      <span className={styles.diffInfo}>
                                        {result.diffPixels.toLocaleString()} pixels
                                      </span>
                                    )}
                                    {result.diffPercent !== undefined && (
                                      <span className={styles.diffInfo}>
                                        {result.diffPercent.toFixed(2)}%
                                      </span>
                                    )}
                                    {failureReason && (
                                      <span className={styles.failureReason}>{failureReason}</span>
                                    )}
                                  </div>
                                </div>
                              </li>
                            );
                          });
                      })()}
                    </ul>
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
          )}
        </>
      )}
    </>
  );
};
