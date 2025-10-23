import React, { useEffect } from 'react';
import { useStorybookApi } from '@storybook/manager-api';
import './StoryHighlighter.module.css';

type StoryHighlighterProps = {
  failedStories: string[];
};

export const StoryHighlighter: React.FC<StoryHighlighterProps> = ({ failedStories }) => {
  const api = useStorybookApi();

  useEffect(() => {
    // Importing the CSS module applies global styles via :global selectors

    // Function to clear all existing highlighting
    const clearAllHighlighting = () => {
      const existingHighlighted = document.querySelectorAll(
        '.failed-story-item, .failed-parent-item',
      );
      existingHighlighted.forEach((element) => {
        element.classList.remove('failed-story-item', 'failed-parent-item', 'selected');
      });
    };

    // Function to get current selected story ID
    const getCurrentStoryId = (): string | null => {
      const currentStory = api.getCurrentStoryData();
      return currentStory?.id || null;
    };

    // Function to find story element by ID
    const findStoryElement = (storyId: string): Element | null => {
      const selectors = [
        `[data-item-id="${storyId}"]`,
        `#${storyId}`,
        `button[id="${storyId}"]`,
        `a[id="${storyId}"]`,
        `[data-testid="sidebar-item-${storyId}"]`,
        `[aria-label*="${storyId}"]`,
        `a[href*="${storyId}"]`,
        `button[aria-label*="${storyId}"]`,
        `[href*="?id=${storyId}"]`,
        `[href*="&id=${storyId}"]`,
      ];

      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element) return element;
      }

      // Fallback: try to find by text content or href
      const allStoryElements = document.querySelectorAll(
        'button[id], a[href], [role="menuitem"], [role="button"], [data-testid*="story"], [data-testid*="item"]',
      );

      for (const element of Array.from(allStoryElements)) {
        const href = element.getAttribute('href') || '';
        const textContent = element.textContent || '';
        const id = element.getAttribute('id') || '';
        const dataItemId = element.getAttribute('data-item-id') || '';

        if (
          href.includes(storyId) ||
          textContent.includes(storyId) ||
          id === storyId ||
          dataItemId === storyId
        ) {
          return element;
        }
      }

      return null;
    };

    // Function to find parent component element
    const findParentComponent = (storyId: string): Element | null => {
      const storyParts = storyId.split('--');
      if (storyParts.length > 1) {
        const componentId = storyParts[0];
        return document.querySelector(`#${componentId}`);
      }
      return null;
    };

    // Function to expand collapsed component
    const expandComponent = (componentElement: Element): void => {
      const isCollapsed = componentElement.getAttribute('aria-expanded') === 'false';
      if (isCollapsed) {
        (componentElement as HTMLElement).click();
      }
    };

    // Function to highlight specific stories
    const highlightStories = (storyIds: string[]) => {
      // Clear all existing highlighting first
      clearAllHighlighting();

      if (storyIds.length === 0) return;

      const currentStoryId = getCurrentStoryId();

      // Apply highlighting to new failed stories
      storyIds.forEach((storyId) => {
        const storyElement = findStoryElement(storyId);

        if (storyElement) {
          // Add failed story highlighting
          storyElement.classList.add('failed-story-item');

          // Add selected highlighting if this is the current story
          if (currentStoryId === storyId) {
            storyElement.classList.add('selected');
          }

          // Highlight parent component
          const parentElement = findParentComponent(storyId);
          if (parentElement) {
            parentElement.classList.add('failed-parent-item');

            // Expand parent if collapsed
            expandComponent(parentElement);
          }
        } else {
          // Try to find the parent component and expand it
          const parentElement = findParentComponent(storyId);
          if (parentElement) {
            // Expand parent if collapsed
            expandComponent(parentElement);

            // Wait a bit for the expansion animation, then try to find the story again
            setTimeout(() => {
              const storyElement = findStoryElement(storyId);
              if (storyElement) {
                storyElement.classList.add('failed-story-item');

                // Add selected highlighting if this is the current story
                if (currentStoryId === storyId) {
                  storyElement.classList.add('selected');
                }
              }
            }, 300);

            // Highlight parent even if story not found yet
            parentElement.classList.add('failed-parent-item');
          }
        }
      });
    };

    // Highlight stories immediately
    highlightStories(failedStories);

    // Set up event-driven re-highlighting instead of polling
    const handleStoryChanged = () => {
      // Re-highlight when story changes (in case selection changes)
      highlightStories(failedStories);
    };

    const handleStoryRendered = () => {
      // Re-highlight when story finishes rendering (in case DOM structure changes)
      highlightStories(failedStories);
    };

    // Listen for Storybook events
    const channel = api.getChannel();
    if (channel) {
      channel.on('storyChanged', handleStoryChanged);
      channel.on('storyRendered', handleStoryRendered);

      return () => {
        channel.off('storyChanged', handleStoryChanged);
        channel.off('storyRendered', handleStoryRendered);
        clearAllHighlighting();
        // styles are module-based; nothing to remove
      };
    }

    return () => {
      clearAllHighlighting();
      // styles are module-based; nothing to remove
    };
  }, [failedStories, api]);

  return null; // This component doesn't render anything visible
};
