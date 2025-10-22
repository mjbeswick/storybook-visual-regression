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
  const shouldPersistTerminal = React.useRef<boolean>(false);
  const hasShownRunningMessage = React.useRef<boolean>(false);
  const resizeObserverRef = React.useRef<ResizeObserver | null>(null);

  // Helper function to calculate optimal terminal dimensions
  const calculateTerminalDimensions = (width: number, height: number) => {
    // Font size: 14px, Padding: 8px on each side (16px total)
    // More conservative font dimensions to prevent overflow
    const fontWidth = 9.0; // Slightly larger to prevent horizontal overflow
    const fontHeight = 20.1; // Slightly larger to prevent vertical overflow
    const padding = 20; // Increased padding for safety margin

    const availableWidth = width - padding;
    const availableHeight = height - padding;

    const cols = Math.max(1, Math.floor(availableWidth / fontWidth));
    const rows = Math.max(1, Math.floor(availableHeight / fontHeight));

    return { cols, rows };
  };

  // Initialize xterm.js terminal when the log container is shown
  React.useEffect(() => {
    // Only initialize when we have logs or are running
    if (!isRunning && logs.length === 0) {
      return;
    }

    if (!terminalRef.current) {
      return;
    }

    // Don't reinitialize if already exists and is still attached to DOM
    if (terminalInstance.current) {
      // Check if terminal is still properly attached to the DOM
      const terminalElement = terminalRef.current?.querySelector('.xterm');
      if (terminalElement && terminalInstance.current.element?.isConnected) {
        return; // Terminal exists and is attached, no need to recreate
      } else {
        // Terminal instance exists but not attached to DOM, dispose and recreate
        console.log('[Visual Regression] Terminal detached from DOM, recreating...');
        terminalInstance.current.dispose();
        terminalInstance.current = null;
        fitAddon.current = null;
        shouldPersistTerminal.current = false; // Allow recreation
      }
    }

    // Create terminal instance
    const terminal = new Terminal({
      theme: {
        background: '#ffffff',
        foreground: '#4d4d4c',
        cursor: '#4d4d4c',
        cursorAccent: '#ffffff',
        selectionBackground: '#d6d6d6',
        black: '#000000',
        red: '#d70000',
        green: '#718c00',
        yellow: '#d75f00',
        blue: '#4271ae',
        magenta: '#8959a8',
        cyan: '#3e999f',
        white: '#ffffff',
        brightBlack: '#4d4d4c',
        brightRed: '#d70000',
        brightGreen: '#718c00',
        brightYellow: '#d75f00',
        brightBlue: '#4271ae',
        brightMagenta: '#8959a8',
        brightCyan: '#3e999f',
        brightWhite: '#ffffff',
      },
      fontSize: 14,
      fontFamily: 'Monaco, Menlo, "Ubuntu Mono", monospace',
      cursorBlink: false,
      disableStdin: true, // Read-only terminal
      convertEol: true, // Let xterm.js handle line endings naturally
      allowProposedApi: true, // Enable proposed APIs for better terminal features
      rescaleOverlappingGlyphs: true,
      allowTransparency: true,
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
      cursorStyle: 'block',
      cursorWidth: 1,
      scrollback: 10000,
      letterSpacing: 0.5,
      lineHeight: 1.2,
      // Enable 256-color support
      cols: 120,
      rows: 30,
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
          // Calculate optimal terminal dimensions for initial fit
          const terminalElement = terminalRef.current;
          if (terminalElement) {
            const rect = terminalElement.getBoundingClientRect();
            const { cols, rows } = calculateTerminalDimensions(rect.width, rect.height);

            console.log(
              `Initial terminal fit: ${rect.width}x${rect.height}, Terminal: ${cols}x${rows}`,
            );

            // Fit and resize with calculated dimensions
            fit.fit();
            terminal.resize(cols, rows);
            terminal.refresh(0, rows - 1);
          } else {
            // Fallback to basic fit
            fit.fit();
          }
        } catch (error) {
          console.warn('Initial terminal fit error:', error);
        }
      }, 100);
    } catch {
      // ignore terminal opening errors
    }

    // Mark that terminal should persist once created
    shouldPersistTerminal.current = true;

    // Cleanup function - only dispose when logs are explicitly cleared
    return () => {
      if (terminalInstance.current && !shouldPersistTerminal.current) {
        terminalInstance.current.dispose();
        terminalInstance.current = null;
        fitAddon.current = null;
      }
      // Also clean up resize observer
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect();
        resizeObserverRef.current = null;
      }
    };
  }, [isRunning, logs.length > 0]);

  // Set up ResizeObserver to handle panel resizing
  React.useEffect(() => {
    const terminal = terminalInstance.current;
    const fit = fitAddon.current;
    const terminalElement = terminalRef.current;

    if (!terminal || !fit || !terminalElement) {
      return;
    }

    // Find the panel tab content container
    const panelTabContent = document.querySelector('#panel-tab-content');
    if (!panelTabContent) {
      return;
    }

    // Create ResizeObserver to watch for panel size changes
    const resizeObserver = new ResizeObserver((entries) => {
      // Debounce resize events to avoid excessive calls
      setTimeout(() => {
        try {
          for (const entry of entries) {
            const { width, height } = entry.contentRect;
            const { cols, rows } = calculateTerminalDimensions(width, height);

            console.log(`Panel resized: ${width}x${height}, Terminal: ${cols}x${rows}`);

            // First fit the terminal to the container
            fit.fit();

            // Then resize the terminal instance with calculated dimensions
            terminal.resize(cols, rows);

            // Finally refresh to ensure proper display
            terminal.refresh(0, rows - 1);
          }
        } catch (error) {
          console.warn('Terminal resize error:', error);
        }
      }, 50);
    });

    // Start observing the panel tab content
    resizeObserver.observe(panelTabContent);
    resizeObserverRef.current = resizeObserver;

    // Cleanup function
    return () => {
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect();
        resizeObserverRef.current = null;
      }
    };
  }, [terminalInstance.current, fitAddon.current]);

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
      shouldPersistTerminal.current = false; // Allow terminal to be disposed
      hasShownRunningMessage.current = false; // Reset running message flag
      return;
    }

    // If we're starting a new test run (isRunning=true)
    // Check if this is a fresh start by comparing with last rendered index
    if (isRunning && lastRenderedIndexRef.current === logs.length) {
      // Add separator line if there are previous logs
      if (logs.length > 0) {
        terminal.write('\r\n\r\n' + '─'.repeat(60) + '\r\n');
      }
      terminal.write('Running…');
      hasShownRunningMessage.current = true;
      return;
    }

    // If we have logs, render them
    if (logs.length > 0) {
      // Clear terminal only when explicitly cleared by user (logs.length === 0 case above)
      // Don't clear when starting a new test run to preserve previous output

      const start = lastRenderedIndexRef.current;
      if (start >= logs.length) {
        return;
      }

      // Write new content to terminal - pass raw output directly to xterm.js
      const newLogs = logs.slice(start);
      if (newLogs.length > 0) {
        // If we showed "Running..." message, clear it before showing logs
        if (hasShownRunningMessage.current && start === 0) {
          // Clear the "Running..." message by moving cursor to beginning of line and clearing it
          terminal.write('\r\x1b[K');
          hasShownRunningMessage.current = false;
        }

        newLogs.forEach((log) => {
          // Pass raw terminal output directly to xterm.js without any processing
          // This preserves all ANSI escape sequences, cursor movements, and formatting
          terminal.write(log);
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
    if (!isChannelReady) {
      return;
    }
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
