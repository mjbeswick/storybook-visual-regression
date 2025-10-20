import React from 'react';
import { useChannel, useStorybookApi } from '@storybook/manager-api';
import { ScrollArea, Button } from '@storybook/components';
import { PlayIcon, SyncIcon, DownloadIcon } from '@storybook/icons';
import { EVENTS } from './constants';
import styles from './Panel.module.css';
import { useTestResults } from './TestResultsContext';

type PanelProps = {
  active?: boolean;
};

export const Panel: React.FC<PanelProps> = ({ active = true }) => {
  const api = useStorybookApi();
  const emit = useChannel({});
  const { results, isRunning, logs } = useTestResults();

  const logRef = React.useRef<HTMLDivElement | null>(null);
  const lastRenderedIndexRef = React.useRef<number>(0);

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
      const line = logs[i];
      const appendLine = (text: string) => {
        frag.append(document.createTextNode(text));
        // Ensure each appended chunk ends with a newline for readability
        if (!/\n$/.test(text)) frag.append(document.createTextNode('\n'));
      };

      const parseJsonFromLine = (raw: string): unknown => {
        try {
          return JSON.parse(raw);
        } catch {
          // Try parsing Server-Sent Events style: `data: {...}`
          const match = /^data:\s*(\{[\s\S]*\})\s*$/.exec(raw);
          if (match) {
            try {
              return JSON.parse(match[1]);
            } catch {
              return null;
            }
          }
          return null;
        }
      };

      const obj = parseJsonFromLine(line) as {
        type?: string;
        data?: unknown;
        error?: unknown;
        test?: { name?: string; status?: string; duration?: number };
      } | null;

      if (obj) {
        if (obj.type === 'stdout' && typeof obj.data === 'string') {
          appendLine(obj.data);
          continue;
        }
        if (obj.type === 'error' && obj.error) {
          appendLine(String(obj.error));
          continue;
        }
        if (obj.type === 'test-result' && obj.test) {
          const status = (obj.test.status || '').toLowerCase();
          const isPass = status === 'passed' || status === 'ok' || status === 'success';
          const symbol = isPass ? '✓' : '✗';
          const name = obj.test.name || 'Unnamed test';
          const duration = typeof obj.test.duration === 'number' ? `${obj.test.duration}ms` : '';
          appendLine(`${symbol} ${name}${duration ? ` (${duration})` : ''}`);
          continue;
        }
        // ignore 'start' and 'complete' payloads silently
      } else {
        // Not JSON; render as-is
        appendLine(line);
      }
    }
    el.appendChild(frag);
    // Auto-scroll to bottom to keep latest output visible
    el.scrollTop = el.scrollHeight;
    lastRenderedIndexRef.current = logs.length;
  }, [logs, isRunning]);

  const totalTests = results.length;
  const passedTests = results.filter((r) => r.status === 'passed').length;
  const failedTests = results.filter((r) => r.status === 'failed').length;

  const handleRunTest = () => {
    const currentStory = api.getCurrentStoryData();
    if (currentStory) {
      emit(EVENTS.RUN_TEST, { storyId: currentStory.id });
    }
  };

  const handleRunAllTests = () => {
    emit(EVENTS.RUN_ALL_TESTS);
  };

  const handleUpdateBaseline = () => {
    const currentStory = api.getCurrentStoryData();
    if (currentStory) {
      emit(EVENTS.UPDATE_BASELINE, { storyId: currentStory.id });
    }
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
          {isRunning && <div className={styles.log} ref={logRef} />}
          {!isRunning && (
            <ScrollArea vertical>
              <div className={styles.section}>
                <div className={styles.buttonsRow}>
                  <Button
                    onClick={handleRunTest}
                    disabled={isRunning}
                    title="Run visual regression test for the current story"
                  >
                    <PlayIcon className={styles.buttonIcon} />
                    Test Current
                  </Button>
                  <Button
                    onClick={handleUpdateBaseline}
                    disabled={isRunning}
                    title="Update baseline snapshot for the current story"
                  >
                    <DownloadIcon className={styles.buttonIcon} />
                    Update Snapshot
                  </Button>
                  <Button
                    onClick={handleRunAllTests}
                    disabled={isRunning}
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
