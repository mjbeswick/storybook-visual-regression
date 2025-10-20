import React from 'react';
import { addons, types } from '@storybook/manager-api';
import { Tool } from './Tool';
import { Panel } from './Panel';
import { TestResultsProvider } from './TestResultsContext';
import { ADDON_ID, TOOL_ID, PANEL_ID } from './constants';

addons.register(ADDON_ID, () => {
  addons.add(TOOL_ID, {
    type: types.TOOL,
    title: 'Visual Regression',
    match: ({ viewMode }) => viewMode === 'story',
    render: () => (
      <TestResultsProvider>
        <Tool />
      </TestResultsProvider>
    ),
  });

  addons.add(PANEL_ID, {
    type: types.PANEL,
    title: 'Visual Regression',
    match: ({ viewMode }) => viewMode === 'story',
    render: ({ active }) => (
      <TestResultsProvider>
        <Panel active={active} />
      </TestResultsProvider>
    ),
  });
});
