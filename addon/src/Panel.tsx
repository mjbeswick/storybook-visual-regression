import React from 'react';
import { useChannel, useStorybookApi } from '@storybook/manager-api';
import { ScrollArea, Button } from '@storybook/components';
import { PlayIcon, SyncIcon, DownloadIcon } from '@storybook/icons';
import { EVENTS } from './constants';
import styles from './Panel.module.css';
import { useTestResults } from './TestResultsContext';
import Convert from 'ansi-to-html';

type PanelProps = {
  active?: boolean;
};

export const Panel: React.FC<PanelProps> = ({ active = true }) => {
  const api = useStorybookApi();
  const emit = useChannel({});
  const { results, isRunning, logs, cancelTest, clearLogs } = useTestResults();

  // Check if channel is available
  const channel = api.getChannel();
  const isChannelReady = !!channel;

  const logRef = React.useRef<HTMLDivElement | null>(null);
  const lastRenderedIndexRef = React.useRef<number>(0);
  const cancelButtonRef = React.useRef<HTMLButtonElement | null>(null);

  // Initialize ANSI to HTML converter
  const convert = new Convert({
    fg: '#e5e7eb', // Default foreground color
    bg: '#0b1020', // Default background color
    newline: true,
    escapeXML: true,
    stream: false,
  });

  React.useEffect(() => {
    if (!isRunning) {
      // Reset counters when leaving running state
      lastRenderedIndexRef.current = 0;
      return;
    }
    const el = logRef.current;
    if (!el) return;

    el.style.height = '100%'; // ensure the log container takes up the full height of the panel

    if (logs.length === 0) {
      el.textContent = 'Running…';
      lastRenderedIndexRef.current = 0;
      return;
    }

    // On first render with logs, clear placeholder
    if (lastRenderedIndexRef.current === 0) {
      el.textContent = '';
    }

    const start = lastRenderedIndexRef.current;
    if (start >= logs.length) return;

    const frag = document.createDocumentFragment();
    for (let i = start; i < logs.length; i++) {
      let line = logs[i];
      const trimmedLine = line.trim();

      // Handle empty lines - render as blank div
      if (!trimmedLine) {
        const emptyDiv = document.createElement('div');
        emptyDiv.innerHTML = '&nbsp;'; // Non-breaking space to maintain height
        frag.appendChild(emptyDiv);
        continue;
      }

      // Check if this is JSON from the server (e.g., {"type":"stdout","data":"..."})
      if (trimmedLine.startsWith('{')) {
        try {
          const obj = JSON.parse(trimmedLine) as { type?: string; data?: string };
          if (obj.type === 'stdout' && typeof obj.data === 'string') {
            // Extract the actual text from the JSON wrapper
            line = obj.data;
          } else if (obj.type === 'start') {
            // Skip start messages
            continue;
          } else {
            // Unknown JSON type, skip it
            continue;
          }
        } catch {
          // Not valid JSON, skip it
          continue;
        }
      }

      // Split multi-line content into separate lines
      const lines = line.split('\n');
      for (const textLine of lines) {
        const trimmed = textLine.trim();

        // Handle empty lines within multi-line content
        if (!trimmed) {
          const emptyDiv = document.createElement('div');
          emptyDiv.innerHTML = '&nbsp;';
          frag.appendChild(emptyDiv);
          continue;
        }

        // Convert ANSI codes to HTML
        const htmlContent = convert.toHtml(textLine);

        // Create a container for this line
        const lineDiv = document.createElement('div');
        lineDiv.innerHTML = htmlContent;

        // Append the line container to the fragment
        frag.appendChild(lineDiv);
      }
    }
    el.appendChild(frag);
    // Auto-scroll to bottom to keep latest output visible
    el.scrollTop = el.scrollHeight;
    lastRenderedIndexRef.current = logs.length;
  }, [logs, isRunning]);

  // Calculate scrollbar width and adjust cancel button position
  React.useEffect(() => {
    const updateCancelButtonPosition = () => {
      const logElement = logRef.current;
      const cancelButton = cancelButtonRef.current;

      if (!logElement || !cancelButton) return;

      // Calculate scrollbar width
      const scrollbarWidth = logElement.offsetWidth - logElement.clientWidth;

      // Adjust cancel button position to account for scrollbar
      const baseOffset = 16; // Base offset from CSS
      const totalOffset = baseOffset + scrollbarWidth;

      cancelButton.style.right = `${totalOffset}px`;
    };

    // Update position when logs change (which might affect scrollbar visibility)
    updateCancelButtonPosition();

    // Also update on window resize
    window.addEventListener('resize', updateCancelButtonPosition);

    return () => {
      window.removeEventListener('resize', updateCancelButtonPosition);
    };
  }, [logs, isRunning]);

  const totalTests = results.length;
  const passedTests = results.filter((r) => r.status === 'passed').length;
  const failedTests = results.filter((r) => r.status === 'failed').length;

  const handleRunTest = () => {
    if (!isChannelReady) {
      console.warn('[Visual Regression] Panel: Channel not ready, cannot run test');
      return;
    }
    const currentStory = api.getCurrentStoryData();
    if (currentStory) {
      console.log('[Visual Regression] Panel: Running test for story:', currentStory.id);
      emit(EVENTS.RUN_TEST, { storyId: currentStory.id });
    } else {
      console.warn('[Visual Regression] Panel: No current story available');
    }
  };

  const handleRunAllTests = () => {
    if (!isChannelReady) {
      console.warn('[Visual Regression] Panel: Channel not ready, cannot run all tests');
      return;
    }
    console.log('[Visual Regression] Panel: Running all tests');
    emit(EVENTS.RUN_ALL_TESTS);
  };

  const handleUpdateBaseline = () => {
    const currentStory = api.getCurrentStoryData();
    if (currentStory) {
      console.log('[Visual Regression] Panel: Updating baseline for story:', currentStory.id);
      emit(EVENTS.UPDATE_BASELINE, { storyId: currentStory.id });
    } else {
      console.warn('[Visual Regression] Panel: No current story available for baseline update');
    }
  };

  const handleCancelTest = () => {
    if (!isChannelReady) {
      console.warn('[Visual Regression] Panel: Channel not ready, cannot cancel test');
      return;
    }
    console.log('[Visual Regression] Panel: Cancelling test');
    cancelTest();
    emit(EVENTS.CANCEL_TEST);
  };

  // Removed summary counters and spinner for simplified failure list

  // Using Storybook's built-in Button styles via @storybook/components

  const showDiffInIframe = (result: { storyId: string; storyName?: string; diffPath?: string }) => {
    if (!result.diffPath) return;
    const iframe = document.getElementById('storybook-preview-iframe') as HTMLIFrameElement;
    if (!iframe) return;

    // Build URL the addon server serves
    let relativePath = result.diffPath;
    const visualRegressionIndex = result.diffPath.indexOf('/visual-regression/');
    if (visualRegressionIndex !== -1) {
      relativePath = result.diffPath.substring(
        visualRegressionIndex + '/visual-regression/'.length,
      );
    }
    const imageUrl = `http://localhost:6007/image/${encodeURIComponent(relativePath)}`;

    const htmlContent = `<!DOCTYPE html><html><head><style>
      body{margin:0;padding:0;background:#0b1020;display:flex;justify-content:center;align-items:center;min-height:100vh}
      img{max-width:100%;max-height:100vh;object-fit:contain}
    </style></head><body>
      <img src="${imageUrl}" alt="diff image for ${result.storyName || result.storyId}"/>
    </body></html>`;

    iframe.srcdoc = htmlContent;

    // Emit event to notify Tool component that diff is being shown
    emit(EVENTS.DIFF_SHOWN, { storyId: result.storyId, type: 'diff' });
  };

  return (
    <>
      {!active && null}
      {active && (
        <>
          {(isRunning || logs.length > 0) && (
            <div className={styles.logContainer}>
              <div className={styles.log} ref={logRef} />
              <button
                ref={cancelButtonRef}
                className={isRunning ? styles.cancelButton : styles.closeButton}
                onClick={isRunning ? handleCancelTest : clearLogs}
                title={isRunning ? 'Cancel running tests' : 'Close log panel'}
              >
                {isRunning ? 'Cancel' : 'Close'}
              </button>
            </div>
          )}
          {!isRunning && logs.length === 0 && (
            <ScrollArea vertical>
              <div className={styles.section}>
                <div className={styles.buttonsRow}>
                  <Button
                    onClick={handleRunTest}
                    disabled={isRunning || !isChannelReady}
                    title="Run visual regression test for the current story"
                  >
                    <PlayIcon className={styles.buttonIcon} />
                    Test Current
                  </Button>
                  <Button
                    onClick={handleUpdateBaseline}
                    disabled={isRunning || !isChannelReady}
                    title="Update baseline snapshot for the current story"
                  >
                    <DownloadIcon className={styles.buttonIcon} />
                    Update Snapshot
                  </Button>
                  <Button
                    onClick={handleRunAllTests}
                    disabled={isRunning || !isChannelReady}
                    title="Run visual regression tests for all stories"
                  >
                    <SyncIcon className={styles.buttonIcon} />
                    Test All
                  </Button>
                </div>

                {/* spinner keyframes moved to Panel.module.css */}

                {results.some((r) => r.status === 'failed') && (
                  <div>
                    <div className={styles.counts}>
                      <span className={styles.count}>Total: {totalTests}</span>
                      <span className={`${styles.count} ${styles.countPassed}`}>
                        Passed: {passedTests}
                      </span>
                      <span className={`${styles.count} ${styles.countFailed}`}>
                        Failed: {failedTests}
                      </span>
                    </div>
                    <ul className={styles.failuresList}>
                      {results
                        .filter((r) => r.status === 'failed')
                        .map((result) => (
                          <li key={result.storyId} className={styles.failureItem}>
                            <button
                              onClick={() => {
                                api.selectStory(result.storyId);
                                setTimeout(() => showDiffInIframe(result), 300);
                              }}
                              className={styles.linkButton}
                            >
                              {result.storyName}
                            </button>
                          </li>
                        ))}
                    </ul>
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
