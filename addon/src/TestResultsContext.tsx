import React, { createContext, useContext, useState, useEffect } from 'react';
import { useStorybookApi } from '@storybook/manager-api';
import { EVENTS } from './constants';
import type { TestResult } from './types';

type TestResultsContextType = {
  results: TestResult[];
  failedStories: string[];
  isRunning: boolean;
  logs: string[];
  cancelTest: () => void;
  clearLogs: () => void;
};

const TestResultsContext = createContext<TestResultsContextType>({
  results: [],
  failedStories: [],
  isRunning: false,
  logs: [],
  cancelTest: () => {},
  clearLogs: () => {},
});

export const TestResultsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const api = useStorybookApi();
  const [state, setState] = useState({
    results: [] as TestResult[],
    failedStories: [] as string[],
    isRunning: false,
    logs: [] as string[],
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
      setState((prev) => ({ ...prev, isRunning: true, results: [] }));
    };

    const handleTestComplete = () => {
      setState((prev) => ({ ...prev, isRunning: false }));
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

    const handleHighlightFailedStories = (storyIds: string[]) => {
      setState((prev) => ({ ...prev, failedStories: storyIds }));
    };

    const handleCancelTest = () => {
      setState((prev) => ({ ...prev, isRunning: false }));
    };

    channel.on(EVENTS.TEST_STARTED, handleTestStarted);
    channel.on(EVENTS.TEST_COMPLETE, handleTestComplete);
    channel.on(EVENTS.TEST_RESULT, handleTestResult);
    channel.on(EVENTS.HIGHLIGHT_FAILED_STORIES, handleHighlightFailedStories);
    channel.on(EVENTS.LOG_OUTPUT, handleLogOutput);
    channel.on(EVENTS.CANCEL_TEST, handleCancelTest);

    return () => {
      channel.off(EVENTS.TEST_STARTED, handleTestStarted);
      channel.off(EVENTS.TEST_COMPLETE, handleTestComplete);
      channel.off(EVENTS.TEST_RESULT, handleTestResult);
      channel.off(EVENTS.HIGHLIGHT_FAILED_STORIES, handleHighlightFailedStories);
      channel.off(EVENTS.LOG_OUTPUT, handleLogOutput);
      channel.off(EVENTS.CANCEL_TEST, handleCancelTest);
    };
  }, [api]);

  const cancelTest = () => {
    // Call the server to stop all running tests
    fetch('http://localhost:6007/stop', { method: 'POST' })
      .then(async (response) => {
        if (response.ok) {
          // Immediately set running to false to update UI
          setState((prev) => ({ ...prev, isRunning: false }));
        }
      })
      .catch(() => {
        // Still set running to false even if request fails
        setState((prev) => ({ ...prev, isRunning: false }));
      });
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
