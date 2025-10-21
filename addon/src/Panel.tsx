import React from 'react';
import { useChannel, useStorybookApi } from '@storybook/manager-api';
import { ScrollArea, Button } from '@storybook/components';
import { PlayIcon, SyncIcon, DownloadIcon } from '@storybook/icons';
import { EVENTS } from './constants';
import styles from './Panel.module.css';
import { useTestResults } from './TestResultsContext';
import { AnsiUp } from 'ansi_up';

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

  // Initialize ANSI to HTML converter for terminal-like rendering
  const ansiUp = React.useMemo(() => {
    const converter = new AnsiUp();
    converter.use_classes = true; // Use CSS classes instead of inline styles
    return converter;
  }, []);

  // Terminal state for handling cursor movements and line overwrites
  const terminalLines = React.useRef<string[]>([]);
  const terminalBuffer = React.useRef<string>('');

  React.useEffect(() => {
    if (!isRunning) {
      // Reset counters when leaving running state
      lastRenderedIndexRef.current = 0;
      terminalBuffer.current = '';
      terminalLines.current = [];
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
      terminalLines.current = [];
    }

    const start = lastRenderedIndexRef.current;
    if (start >= logs.length) return;

    // Process new content chunk by chunk to handle terminal control sequences
    const newContent = logs.slice(start).join('');

    if (newContent) {
      terminalBuffer.current += newContent;

      // Process the buffer to simulate terminal behavior
      const buffer = terminalBuffer.current;

      // Split by lines, but handle carriage returns within lines
      const chunks = buffer.split(/(\r|\n)/);
      let currentLine = terminalLines.current.length > 0 ? terminalLines.current.pop() || '' : '';

      for (const chunk of chunks) {
        if (chunk === '\n') {
          // New line - add current line and start a new one
          terminalLines.current.push(currentLine);
          currentLine = '';
        } else if (chunk === '\r') {
          // Carriage return - cursor goes to beginning of current line (overwrite)
          currentLine = '';
        } else if (chunk) {
          // Regular content - append to current line
          currentLine += chunk;
        }
      }

      // Add the current line back (it might be incomplete)
      terminalLines.current.push(currentLine);

      // Join all lines and clean up ANSI escape sequences
      let processedContent = terminalLines.current.join('\n');

      // Remove ANSI escape sequences that control cursor position but aren't handled by ansi_up
      const ESC = String.fromCharCode(27); // ESC character
      processedContent = processedContent
        // Remove cursor movement sequences (ESC[nA, ESC[nB, ESC[nC, ESC[nD)
        .replace(new RegExp(ESC + '\\[[0-9]*[ABCD]', 'g'), '')
        // Remove cursor position sequences (ESC[n;mH, ESC[nG)
        .replace(new RegExp(ESC + '\\[[0-9]*;?[0-9]*[HG]', 'g'), '')
        // Remove clear sequences (ESC[nJ, ESC[nK)
        .replace(new RegExp(ESC + '\\[[0-9]*[JK]', 'g'), '')
        // Remove save/restore cursor sequences
        .replace(new RegExp(ESC + '\\[s|' + ESC + '\\[u', 'g'), '');

      // Convert ANSI codes to HTML for terminal-like rendering
      const htmlContent = ansiUp.ansi_to_html(processedContent);

      // Clear the element and set the new content
      el.innerHTML = htmlContent;

      // Clear the buffer since we've processed it
      terminalBuffer.current = '';
    }

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

                {/* Show results summary and failed tests */}
                {results.length > 0 && (
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

                    {failedTests === 0 && (
                      <div className={styles.allPassed}>
                        <p>✅ All passed</p>
                      </div>
                    )}
                  </div>
                )}

                {results.some((r) => r.status === 'failed') && (
                  <div>
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
