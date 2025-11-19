import React, { createContext, useContext, useState, useEffect } from 'react';
import { useStorybookApi } from '@storybook/manager-api';
import { EVENTS } from './constants';
import type { TestResult, ProgressInfo } from './types';

// Helper function to get the addon server URL
const getAddonServerUrl = () => {
  const port = process.env.VR_ADDON_PORT || process.env.STORYBOOK_VISUAL_REGRESSION_PORT || '6007';
  return `http://localhost:${port}`;
};

type TestResultsContextType = {
  results: TestResult[];
  failedStories: string[];
  isRunning: boolean;
  isUpdating: boolean;
  logs: string[];
  progress: ProgressInfo | null;
  cancelTest: () => void;
  clearLogs: () => void;
};

const TestResultsContext = createContext<TestResultsContextType>({
  results: [],
  failedStories: [],
  isRunning: false,
  isUpdating: false,
  logs: [],
  progress: null,
  cancelTest: () => {},
  clearLogs: () => {},
});

export const TestResultsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const api = useStorybookApi();
  const [state, setState] = useState({
    results: [] as TestResult[],
    failedStories: [] as string[],
    isRunning: false,
    isUpdating: false,
    logs: [] as string[],
    progress: null as ProgressInfo | null,
  });

  // Listen for test events
  useEffect(() => {
    const channel = api.getChannel();
    if (!channel) {
      const timeoutId = setTimeout(() => {
        // Trigger re-render to try again
        setState((prev) => ({ ...prev }));
      }, 100);
      return () => clearTimeout(timeoutId);
    }

    const handleTestStarted = () => {
      console.log('[VR Addon TestResultsContext] TEST_STARTED received, setting isRunning: true');
      // Don't clear results - we want to keep previous results and just add/update new ones
      setState((prev) => ({ ...prev, isRunning: true, isUpdating: false, progress: null }));
    };

    const handleUpdateStarted = () => {
      console.log('[VR Addon TestResultsContext] UPDATE_STARTED received, setting isUpdating: true');
      setState((prev) => ({ ...prev, isRunning: false, isUpdating: true, results: [] }));
    };

    const handleTestComplete = () => {
      setState((prev) => ({ ...prev, isRunning: false, isUpdating: false }));
    };

    const handleTestResult = (result: TestResult) => {
      setState((prev) => {
        const newResults = [...prev.results];
        const existingIndex = newResults.findIndex((r) => r.storyId === result.storyId);

        if (existingIndex >= 0) {
          newResults[existingIndex] = result;
        } else {
          newResults.push(result);
        }

        const failedStories = newResults.filter((r) => r.status === 'failed').map((r) => r.storyId);

        return {
          ...prev,
          results: newResults,
          failedStories,
        };
      });
    };

    const handleLogOutput = (line: string) => {
      setState((prev) => ({ ...prev, logs: [...prev.logs, line] }));
    };

    const handleProgress = (progress: ProgressInfo) => {
      setState((prev) => ({ ...prev, progress }));
    };

    const handleHighlightFailedStories = (storyIds: string[]) => {
      setState((prev) => ({ ...prev, failedStories: storyIds }));
    };

    const handleCancelTest = () => {
      console.log('[VR Addon] Cancel test event received');
      // Emit cancel event - preview will handle it
      channel.emit(EVENTS.CANCEL_TEST);
      // Set running to false immediately for UI responsiveness
      setState((prev) => ({ ...prev, isRunning: false, isUpdating: false }));
    };

    channel.on(EVENTS.TEST_STARTED, handleTestStarted);
    channel.on(EVENTS.UPDATE_STARTED, handleUpdateStarted);
    channel.on(EVENTS.TEST_COMPLETE, handleTestComplete);
    channel.on(EVENTS.TEST_RESULT, handleTestResult);
    channel.on(EVENTS.HIGHLIGHT_FAILED_STORIES, handleHighlightFailedStories);
    channel.on(EVENTS.LOG_OUTPUT, handleLogOutput);
    channel.on(EVENTS.CANCEL_TEST, handleCancelTest);
    channel.on(EVENTS.PROGRESS, handleProgress);

    // Also set up EventSource to receive events from preview (via preset)
    // This ensures we receive UPDATE_STARTED and TEST_STARTED even if channel doesn't bridge
    let eventSource: EventSource | null = null;
    try {
      eventSource = new EventSource(`${getAddonServerUrl()}/events`);
      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          const { type } = data;
          if (type === EVENTS.UPDATE_STARTED) {
            console.log('[VR Addon TestResultsContext] Received UPDATE_STARTED via EventSource');
            handleUpdateStarted();
          } else if (type === EVENTS.TEST_STARTED) {
            console.log('[VR Addon TestResultsContext] Received TEST_STARTED via EventSource');
            handleTestStarted();
          }
        } catch (error) {
          // Ignore parse errors
        }
      };
    } catch (error) {
      console.error('[VR Addon TestResultsContext] Failed to set up EventSource:', error);
    }

    return () => {
      channel.off(EVENTS.TEST_STARTED, handleTestStarted);
      channel.off(EVENTS.UPDATE_STARTED, handleUpdateStarted);
      channel.off(EVENTS.TEST_COMPLETE, handleTestComplete);
      channel.off(EVENTS.TEST_RESULT, handleTestResult);
      channel.off(EVENTS.HIGHLIGHT_FAILED_STORIES, handleHighlightFailedStories);
      channel.off(EVENTS.LOG_OUTPUT, handleLogOutput);
      channel.off(EVENTS.CANCEL_TEST, handleCancelTest);
      channel.off(EVENTS.PROGRESS, handleProgress);
      if (eventSource) {
        eventSource.close();
      }
    };
  }, [api]);

  const cancelTest = () => {
    console.log('[VR Addon] Cancel test requested');
    const channel = api.getChannel();
    if (channel) {
      channel.emit(EVENTS.CANCEL_TEST);
    }
    // Immediately set running to false for UI responsiveness
    setState((prev) => ({ ...prev, isRunning: false, isUpdating: false }));
  };

  const clearLogs = () => {
    setState((prev) => ({ ...prev, logs: [] }));
  };

  return (
    <TestResultsContext.Provider value={{ ...state, cancelTest, clearLogs }}>
      {children}
    </TestResultsContext.Provider>
  );
};

export const useTestResults = () => {
  const context = useContext(TestResultsContext);
  if (!context) {
    throw new Error('useTestResults must be used within a TestResultsProvider');
  }
  return context;
};
