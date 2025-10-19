import React from 'react';
import { useChannel, useStorybookApi } from '@storybook/manager-api';
import { ScrollArea } from '@storybook/components';
import { EVENTS } from './constants';
import { StoryHighlighter } from './StoryHighlighter';
import { useTestResults } from './TestResultsContext';
import type { VisualRegressionConfig } from './types';

export const Panel: React.FC = () => {
  const api = useStorybookApi();
  const emit = useChannel({});
  const { results, failedStories, isRunning } = useTestResults();

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

  const handleClearResults = () => {
    emit(EVENTS.CLEAR_RESULTS);
  };

  const totalTests = results.length;
  const passedTests = results.filter((r) => r.status === 'passed').length;
  const failedTests = results.filter((r) => r.status === 'failed').length;

  return (
    <>
      <StoryHighlighter failedStories={failedStories} />
      <ScrollArea vertical>
        <div style={{ padding: '16px' }}>
          <div style={{ marginBottom: '24px' }}>
            <h3 style={{ margin: '0 0 12px 0', fontSize: '16px', fontWeight: 'bold' }}>
              Visual Regression
            </h3>
            <div style={{ display: 'flex', gap: '12px', marginBottom: '16px' }}>
              <span style={{ fontSize: '14px' }}>Total: {totalTests}</span>
              <span style={{ fontSize: '14px', color: '#4ade80' }}>Passed: {passedTests}</span>
              <span style={{ fontSize: '14px', color: '#f87171' }}>Failed: {failedTests}</span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '8px', marginBottom: '24px', flexWrap: 'wrap' }}>
            <button
              onClick={handleRunTest}
              disabled={isRunning}
              style={{
                padding: '8px 12px',
                backgroundColor: isRunning ? '#6b7280' : '#3b82f6',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: isRunning ? 'not-allowed' : 'pointer',
                fontSize: '12px',
              }}
            >
              {isRunning ? '⏳ Running...' : 'Test Current Story'}
            </button>
            <button
              onClick={handleRunAllTests}
              disabled={isRunning}
              style={{
                padding: '8px 12px',
                backgroundColor: isRunning ? '#6b7280' : '#8b5cf6',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: isRunning ? 'not-allowed' : 'pointer',
                fontSize: '12px',
              }}
            >
              {isRunning ? '⏳ Running...' : 'Test All Stories'}
            </button>
            <button
              onClick={handleUpdateBaseline}
              disabled={isRunning}
              style={{
                padding: '8px 12px',
                backgroundColor: isRunning ? '#6b7280' : '#f59e0b',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: isRunning ? 'not-allowed' : 'pointer',
                fontSize: '12px',
              }}
            >
              {isRunning ? '⏳ Running...' : 'Update Baseline'}
            </button>
            <button
              onClick={handleClearResults}
              disabled={isRunning}
              style={{
                padding: '8px 12px',
                backgroundColor: isRunning ? '#6b7280' : '#6b7280',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: isRunning ? 'not-allowed' : 'pointer',
                fontSize: '12px',
              }}
            >
              Clear Results
            </button>
          </div>

          {results.length > 0 && (
            <div>
              <h4 style={{ margin: '0 0 12px 0', fontSize: '14px' }}>Test Results</h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {results.map((result) => (
                  <div
                    key={result.storyId}
                    style={{
                      padding: '12px',
                      border: '1px solid #e5e7eb',
                      borderRadius: '4px',
                      backgroundColor: result.status === 'failed' ? '#fef2f2' : '#f0fdf4',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: '8px',
                      }}
                    >
                      <div style={{ fontSize: '14px', fontWeight: '500' }}>{result.storyName}</div>
                      <span
                        style={{
                          padding: '2px 8px',
                          borderRadius: '12px',
                          fontSize: '12px',
                          fontWeight: '500',
                          backgroundColor: result.status === 'failed' ? '#fecaca' : '#bbf7d0',
                          color: result.status === 'failed' ? '#dc2626' : '#16a34a',
                        }}
                      >
                        {result.status}
                      </span>
                    </div>

                    {result.error && (
                      <div style={{ fontSize: '12px', color: '#dc2626', marginTop: '8px' }}>
                        {result.error}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </ScrollArea>
    </>
  );
};
