import React from 'react';
import { useChannel, useStorybookApi } from '@storybook/manager-api';
import { ScrollArea, Button } from '@storybook/components';
import { PlayIcon, SyncIcon, DownloadIcon } from '@storybook/icons';
import { EVENTS } from './constants';
import styles from './Panel.module.css';
import { useTestResults } from './TestResultsContext';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

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

  const terminalRef = React.useRef<HTMLDivElement | null>(null);
  const terminalInstance = React.useRef<Terminal | null>(null);
  const fitAddon = React.useRef<FitAddon | null>(null);
  const lastRenderedIndexRef = React.useRef<number>(0);
  // Initialize xterm.js terminal when the log container is shown
  React.useEffect(() => {
    // Only initialize when we have logs or are running
    if (!isRunning && logs.length === 0) {
      return;
    }

    if (!terminalRef.current) {
      return;
    }

    // Don't reinitialize if already exists
    if (terminalInstance.current) {
      return;
    }

    // Create terminal instance
    const terminal = new Terminal({
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#ffffff',
        cursorAccent: '#000000',
        selectionBackground: '#264f78',
        black: '#000000',
        red: '#cd3131',
        green: '#0dbc79',
        yellow: '#e5e510',
        blue: '#2472c8',
        magenta: '#bc3fbc',
        cyan: '#11a8cd',
        white: '#e5e5e5',
        brightBlack: '#666666',
        brightRed: '#f14c4c',
        brightGreen: '#23d18b',
        brightYellow: '#f5f543',
        brightBlue: '#3b8eea',
        brightMagenta: '#d670d6',
        brightCyan: '#29b8db',
        brightWhite: '#e5e5e5',
      },
      fontSize: 12,
      fontFamily: 'Monaco, Menlo, "Ubuntu Mono", monospace',
      cursorBlink: false,
      disableStdin: true, // Read-only terminal
      rows: 30,
      cols: 120,
      convertEol: false, // Handle line endings manually for better control
      allowProposedApi: true, // Enable proposed APIs for better terminal features
      rescaleOverlappingGlyphs: true,
      // Enable proper ANSI escape sequence handling
      allowTransparency: false,
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
      // Ensure cursor movement and other escape sequences work properly
      cursorStyle: 'block',
      cursorWidth: 1,
    });

    // Create fit addon
    const fit = new FitAddon();
    terminal.loadAddon(fit);

    try {
      // Open terminal in the DOM element
      terminal.open(terminalRef.current);

      // Store references
      terminalInstance.current = terminal;
      fitAddon.current = fit;

      // Initialize terminal with proper modes for ANSI escape sequences
      // Enable cursor key mode and other standard terminal features
      terminal.write('\x1b[?1h'); // Enable cursor key mode
      terminal.write('\x1b[?25h'); // Show cursor

      // Fit terminal to container after a short delay
      setTimeout(() => {
        try {
          fit.fit();
        } catch {
          // ignore fit errors
        }
      }, 100);
    } catch {
      // ignore terminal opening errors
    }

    // Cleanup function
    return () => {
      if (terminalInstance.current) {
        terminalInstance.current.dispose();
        terminalInstance.current = null;
        fitAddon.current = null;
      }
    };
  }, [isRunning, logs.length > 0]);

  // Handle terminal output
  React.useEffect(() => {
    const terminal = terminalInstance.current;
    if (!terminal) {
      return;
    }

    // If logs were cleared (user clicked Close), reset everything
    if (logs.length === 0 && lastRenderedIndexRef.current > 0) {
      terminal.clear();
      lastRenderedIndexRef.current = 0;
      return;
    }

    // If we're starting a new test run (isRunning=true, no logs yet)
    if (isRunning && logs.length === 0) {
      terminal.clear();
      terminal.write('Running…');
      lastRenderedIndexRef.current = 0;
      return;
    }

    // If we have logs, render them
    if (logs.length > 0) {
      // Clear terminal on first logs of a new run
      if (lastRenderedIndexRef.current === 0) {
        terminal.clear();
      }

      const start = lastRenderedIndexRef.current;
      if (start >= logs.length) {
        return;
      }

      // Write new content to terminal - process each log chunk individually
      const newLogs = logs.slice(start);
      if (newLogs.length > 0) {
        newLogs.forEach((log, index) => {
          // Debug line endings and ANSI sequences
          const hasLF = log.includes('\n');
          const hasCR = log.includes('\r');
          const hasAnsiEscapes = /\x1b\[[0-9;]*[a-zA-Z]/.test(log);

          if (hasLF || hasCR || hasAnsiEscapes) {
            console.log(
              `[Terminal Debug] Log ${start + index}:`,
              `LF=${hasLF} CR=${hasCR} ANSI=${hasAnsiEscapes}`,
              JSON.stringify(log.substring(0, 100)),
            );

            // Specifically log cursor movement sequences
            if (hasAnsiEscapes && /\x1b\[[0-9]*[ABCD]/.test(log)) {
              console.log(`[Terminal Debug] Cursor movement detected:`, JSON.stringify(log));
            }
          }

          // Process line endings carefully to avoid breaking ANSI sequences
          let processedLog = log;

          if (!hasAnsiEscapes) {
            // Safe to process line endings for regular text
            // First, temporarily replace existing \r\n with a placeholder
            processedLog = processedLog.replace(/\r\n/g, '__CRLF__');
            // Then replace standalone \n with \r\n
            processedLog = processedLog.replace(/\n/g, '\r\n');
            // Finally, restore the original \r\n sequences
            processedLog = processedLog.replace(/__CRLF__/g, '\r\n');
          }
          // If it has ANSI escapes, send it raw to preserve sequences

          terminal.write(processedLog);
        });
      }

      lastRenderedIndexRef.current = logs.length;
    }

    // When test finishes (!isRunning), keep the terminal content visible
    // Don't reset lastRenderedIndexRef to preserve the output
  }, [logs, isRunning]);

  // Handle terminal resize
  React.useEffect(() => {
    const handleResize = () => {
      if (fitAddon.current && terminalInstance.current) {
        fitAddon.current.fit();
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const totalTests = results.length;
  const passedTests = results.filter((r) => r.status === 'passed').length;
  const failedTests = results.filter((r) => r.status === 'failed').length;

  const handleRunTest = () => {
    if (!isChannelReady) {
      return;
    }
    const currentStory = api.getCurrentStoryData();
    if (currentStory) {
      emit(EVENTS.RUN_TEST, { storyId: currentStory.id });
    }
  };

  const handleRunAllTests = () => {
    if (!isChannelReady) {
      return;
    }
    emit(EVENTS.RUN_ALL_TESTS);
  };

  const handleUpdateBaseline = () => {
    const currentStory = api.getCurrentStoryData();
    if (currentStory) {
      emit(EVENTS.UPDATE_BASELINE, { storyId: currentStory.id });
    }
  };

  const handleCancelTest = () => {
    if (!isChannelReady) {
      return;
    }
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
              <div className={styles.log} ref={terminalRef} />
              <button
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
