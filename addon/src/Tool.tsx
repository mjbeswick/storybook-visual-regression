import React, { useState, useEffect } from 'react';
import { useStorybookApi } from '@storybook/manager-api';
import { IconButton } from '@storybook/components';
import { EyeIcon, PhotoIcon } from '@storybook/icons';
import styles from './Tool.module.css';
import { useTestResults } from './TestResultsContext';
import type { TestResult } from './types';

export const Tool: React.FC = () => {
  const api = useStorybookApi();
  const { results } = useTestResults();
  const [currentResult, setCurrentResult] = useState<TestResult | null>(null);
  const [showingDiff, setShowingDiff] = useState<{
    type: 'diff' | 'actual' | 'expected' | null;
    result: TestResult | null;
  }>({ type: null, result: null });

  // Update current result when story changes or results change
  useEffect(() => {
    const updateCurrentResult = () => {
      const currentStory = api.getCurrentStoryData();

      // Fallback: try to get story ID from URL if getCurrentStoryData() returns null
      let storyId: string | undefined = currentStory?.id;
      if (!storyId) {
        const urlParams = new URLSearchParams(window.location.search);
        storyId = urlParams.get('id') || undefined;
        console.log('[Visual Regression] Tool: Fallback - got story ID from URL:', storyId);
      }

      if (!storyId) {
        console.log('[Visual Regression] Tool: No current story ID found');
        setCurrentResult(null);
        return;
      }

      console.log('[Visual Regression] Tool: Current story:', storyId);
      console.log('[Visual Regression] Tool: Available results:', results);

      const result = results.find((r) => r.storyId === storyId);
      console.log('[Visual Regression] Tool: Found result for current story:', result);

      setCurrentResult(result || null);
    };

    // Update immediately
    updateCurrentResult();

    // Listen for story changes and other relevant events
    const channel = api.getChannel();
    if (channel) {
      const handleStoryChanged = () => {
        console.log('[Visual Regression] Tool: storyChanged event received');
        updateCurrentResult();
      };

      const handleStoryRendered = () => {
        console.log('[Visual Regression] Tool: storyRendered event received');
        // Story has finished rendering, try to detect it
        updateCurrentResult();
      };

      console.log('[Visual Regression] Tool: Setting up event listeners');
      channel.on('storyChanged', handleStoryChanged);
      channel.on('storyRendered', handleStoryRendered);

      return () => {
        console.log('[Visual Regression] Tool: Cleaning up event listeners');
        channel.off('storyChanged', handleStoryChanged);
        channel.off('storyRendered', handleStoryRendered);
      };
    } else {
      console.log('[Visual Regression] Tool: No channel available, falling back to polling');
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
      console.warn('[Visual Regression] Storybook iframe not found');
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
      console.warn(
        `[Visual Regression] No ${imageType} image path available for ${result.storyId}`,
      );
      return;
    }

    console.log(`[Visual Regression] Image path for ${imageType}:`, imagePath);

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

      console.log(`[Visual Regression] Converting image path:`, {
        original: imagePath,
        relative: relativePath,
        url: imageUrl,
      });

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

      console.log(`[Visual Regression] Showing ${imageType} image for ${result.storyId} in iframe`);
    } catch (error) {
      console.error('[Visual Regression] Error showing diff in iframe:', error);
    }
  };

  // Function to restore original iframe content
  const restoreIframe = () => {
    const iframe = document.getElementById('storybook-preview-iframe') as HTMLIFrameElement;
    if (iframe) {
      // Remove srcdoc to restore original content
      iframe.removeAttribute('srcdoc');
      setShowingDiff({ type: null, result: null });
      console.log('[Visual Regression] Restored original iframe content');
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
      {/* Test buttons removed */}

      {/* Diff buttons for failed tests */}
      {(() => {
        console.log('[Visual Regression] Tool: Rendering diff buttons check:', {
          currentResult,
          hasCurrentResult: !!currentResult,
          status: currentResult?.status,
          isFailed: currentResult?.status === 'failed',
          diffPath: currentResult?.diffPath,
          actualPath: currentResult?.actualPath,
          expectedPath: currentResult?.expectedPath,
        });
        return currentResult && currentResult.status === 'failed';
      })() && (
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
