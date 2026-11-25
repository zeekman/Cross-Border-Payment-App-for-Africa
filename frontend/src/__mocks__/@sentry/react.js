module.exports = {
  captureException: jest.fn(() => 'test-event-id'),
  captureMessage: jest.fn(),
  captureUserFeedback: jest.fn(),
  setUser: jest.fn(),
  withScope: jest.fn(),
  init: jest.fn(),
  withProfiler: (component) => component,
};
