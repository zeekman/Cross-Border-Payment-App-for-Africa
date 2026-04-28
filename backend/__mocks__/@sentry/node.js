module.exports = {
  init: jest.fn(),
  Handlers: {
    requestHandler: () => (req, res, next) => next(),
    errorHandler: () => (err, req, res, next) => next(err),
  },
  captureException: jest.fn(),
  captureMessage: jest.fn(),
};
