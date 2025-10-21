import React, { useState, useEffect } from 'react';
import { useStorybookApi } from '@storybook/manager-api';
import { IconButton } from '@storybook/components';
import { EyeIcon, PhotoIcon } from '@storybook/icons';
import styles from './Tool.module.css';
import { useTestResults } from './TestResultsContext';
import { EVENTS } from './constants';
import type { TestResult } from './types';

export const Tool: React.FC = () => {
  const api = useStorybookApi();
  const { results } = useTestResults();
  const [currentResult, setCurrentResult] = useState<TestResult | null>(null);
  const [showingDiff, setShowingDiff] = useState<{
    type: 'diff' | 'actual' | 'expected' | null;
    result: TestResult | null;
  }>({ type: null, result: null });

  // Get the channel for emitting events
  const channel = api.getChannel();

  // Update current result when story changes or results change
  useEffect(() => {
    const updateCurrentResult = () => {
      const currentStory = api.getCurrentStoryData();

      // Fallback: try to get story ID from URL if getCurrentStoryData() returns null
      let storyId: string | undefined = currentStory?.id;
      if (!storyId) {
        const urlParams = new URLSearchParams(window.location.search);
        storyId = urlParams.get('id') || undefined;
      }

      if (!storyId) {
        setCurrentResult(null);
        // Reset showingDiff when no story is found
        setShowingDiff({ type: null, result: null });
        return;
      }

      const result = results.find((r) => r.storyId === storyId);

      setCurrentResult(result || null);
    };

    // Update immediately
    updateCurrentResult();

    // Listen for story changes and other relevant events
    const channel = api.getChannel();
    if (channel) {
      const handleStoryChanged = () => {
        // Restore iframe content when story changes to show the new story instead of diff
        restoreIframe();
        // Reset showingDiff state when story changes
        setShowingDiff({ type: null, result: null });
        updateCurrentResult();
      };

      const handleStoryRendered = () => {
        // Story has finished rendering, try to detect it
        updateCurrentResult();
      };

      const handleDiffShown = (data: unknown) => {
        const eventData = data as { storyId?: string; type?: string };
        if (eventData.storyId && eventData.type) {
          // Find the result for this story and update showingDiff state
          const result = results.find((r) => r.storyId === eventData.storyId);
          if (
            result &&
            (eventData.type === 'diff' ||
              eventData.type === 'expected' ||
              eventData.type === 'actual')
          ) {
            setShowingDiff({ type: eventData.type as 'diff' | 'expected' | 'actual', result });
          }
        }
      };

      const handleDiffHidden = () => {
        setShowingDiff({ type: null, result: null });
      };

      channel.on('storyChanged', handleStoryChanged);
      channel.on('storyRendered', handleStoryRendered);
      channel.on(EVENTS.DIFF_SHOWN, handleDiffShown);
      channel.on(EVENTS.HIDE_DIFF, handleDiffHidden);

      return () => {
        channel.off('storyChanged', handleStoryChanged);
        channel.off('storyRendered', handleStoryRendered);
        channel.off(EVENTS.DIFF_SHOWN, handleDiffShown);
        channel.off(EVENTS.HIDE_DIFF, handleDiffHidden);
      };
    } else {
      // Fallback to polling if no channel available
      const interval = setInterval(updateCurrentResult, 2000);
      return () => clearInterval(interval);
    }
  }, [api, results]);

  // Removed unused test handlers - tests are now run from the Panel component

  // Function to toggle diff image in Storybook iframe
  const toggleDiffInIframe = (result: TestResult, imageType: 'diff' | 'actual' | 'expected') => {
    const iframe = document.getElementById('storybook-preview-iframe') as HTMLIFrameElement;
    if (!iframe) {
      return;
    }

    // Check if we're already showing this image
    if (showingDiff.type === imageType && showingDiff.result?.storyId === result.storyId) {
      // Toggle off - restore original content
      restoreIframe();
      setShowingDiff({ type: null, result: null });
      return;
    }

    const imagePath =
      imageType === 'diff'
        ? result.diffPath
        : imageType === 'actual'
          ? result.actualPath
          : result.expectedPath;

    if (!imagePath) {
      return;
    }

    try {
      // Convert file path to relative path for the web server
      // Extract the relative path from the full file system path
      // The image path should be something like: /path/to/project/visual-regression/results/...
      // We need to extract everything after "visual-regression/"
      let relativePath = imagePath;

      // Find the "visual-regression" directory in the path
      const visualRegressionIndex = imagePath.indexOf('/visual-regression/');
      if (visualRegressionIndex !== -1) {
        // Extract everything after "/visual-regression/"
        relativePath = imagePath.substring(visualRegressionIndex + '/visual-regression/'.length);
      }

      // Create the web server URL
      const imageUrl = `http://localhost:6007/image/${encodeURIComponent(relativePath)}`;

      // Simple HTML with just the image
      const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body {
              margin: 0;
              padding: 0;
              background-color: #f9fafb;
              display: flex;
              justify-content: center;
              align-items: center;
              min-height: 100vh;
            }
            .error-message {
              color: #dc2626;
              margin-top: 10px;
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            }
          </style>
        </head>
        <body>
          <img 
            class="diff-image" 
            src="${imageUrl}" 
            alt="${imageType} image for ${result.storyName}"
            onerror="document.querySelector('.error-message').textContent = 'Failed to load ${imageType} image from server'; document.querySelector('.error-message').style.display = 'block';"
          />
          <div class="error-message" style="display: none;"></div>
        </body>
        </html>
      `;

      // Set the iframe content
      iframe.srcdoc = htmlContent;

      // Update state to track what we're showing
      setShowingDiff({ type: imageType, result });

      // Emit event to notify other components that an image is being shown
      if (channel) {
        channel.emit(EVENTS.DIFF_SHOWN, { storyId: result.storyId, type: imageType });
      }
    } catch {
      // ignore diff display errors
    }
  };

  // Function to restore original iframe content
  const restoreIframe = () => {
    const iframe = document.getElementById('storybook-preview-iframe') as HTMLIFrameElement;
    if (iframe) {
      // Remove srcdoc to restore original content
      iframe.removeAttribute('srcdoc');

      // Emit event to notify other components that diff is hidden
      if (channel) {
        channel.emit(EVENTS.HIDE_DIFF);
      }
    }
  };

  // Listen for messages from iframe (close button)
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data && event.data.type === 'close-diff') {
        restoreIframe();
      }
    };

    window.addEventListener('message', handleMessage);

    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, []);

  return (
    <>
      {currentResult && currentResult.status === 'failed' && (
        <>
          {currentResult!.diffPath && (
            <IconButton
              className={`${styles.diffButton} ${
                showingDiff.type === 'diff' &&
                showingDiff.result?.storyId === currentResult?.storyId
                  ? styles.diffButtonActive
                  : ''
              }`}
              key="visual-regression-diff"
              title="Show visual diff"
              onClick={() => toggleDiffInIframe(currentResult!, 'diff')}
            >
              <EyeIcon style={{ width: 16, height: 16 }} />
              Difference
            </IconButton>
          )}
          {currentResult!.expectedPath && (
            <IconButton
              className={`${styles.diffButton} ${
                showingDiff.type === 'expected' &&
                showingDiff.result?.storyId === currentResult?.storyId
                  ? styles.diffButtonActive
                  : ''
              }`}
              key="visual-regression-expected"
              title="Show expected screenshot"
              onClick={() => toggleDiffInIframe(currentResult!, 'expected')}
            >
              <PhotoIcon style={{ width: 16, height: 16 }} />
              Expected
            </IconButton>
          )}
        </>
      )}
    </>
  );
};
