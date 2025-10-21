export const ADDON_ID = 'storybook-visual-regression';
export const TOOL_ID = `${ADDON_ID}/tool`;
export const DIFF_TOOL_ID = `${ADDON_ID}/diff-tool`;
export const PANEL_ID = `${ADDON_ID}/panel`;

// Event channels for communication
export const EVENTS = {
  RUN_TEST: `${ADDON_ID}/run-test`,
  RUN_ALL_TESTS: `${ADDON_ID}/run-all-tests`,
  UPDATE_BASELINE: `${ADDON_ID}/update-baseline`,
  CANCEL_TEST: `${ADDON_ID}/cancel-test`,
  TEST_STARTED: `${ADDON_ID}/test-started`,
  TEST_COMPLETE: `${ADDON_ID}/test-complete`,
  TEST_RESULT: `${ADDON_ID}/test-result`,
  LOG_OUTPUT: `${ADDON_ID}/log-output`,
  HIGHLIGHT_FAILED_STORIES: `${ADDON_ID}/highlight-failed-stories`,
  CLEAR_RESULTS: `${ADDON_ID}/clear-results`,
  SHOW_DIFF: `${ADDON_ID}/show-diff`,
  HIDE_DIFF: `${ADDON_ID}/hide-diff`,
  DIFF_SHOWN: `${ADDON_ID}/diff-shown`,
} as const;
