import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ErrorBoundary from './ErrorBoundary';

// Module @sentry/react is mocked via moduleNameMapper in package.json
// pointing to src/__mocks__/@sentry/react.js
const Sentry = require('@sentry/react');

// Component that throws an error
const ThrowError = () => {
  throw new Error('Test error');
};

describe('ErrorBoundary', () => {
  beforeEach(() => {
    Sentry.captureException.mockClear();
    Sentry.captureUserFeedback.mockClear();
  });

  test('captures exception and displays fallback UI when child throws', () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <MemoryRouter>
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      </MemoryRouter>
    );

    // Verify fallback UI displays current copy
    expect(screen.getByText('Something went wrong.')).toBeInTheDocument();
    expect(
      screen.getByText('An unexpected error occurred. Our team has been notified.')
    ).toBeInTheDocument();
    expect(screen.getByText('Refresh Page')).toBeInTheDocument();

    // Verify Sentry.captureException was called when child threw
    expect(Sentry.captureException).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  test('renders feedback form, captures input, submits and shows thank-you state', () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <MemoryRouter>
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      </MemoryRouter>
    );

    // Verify error was captured
    expect(Sentry.captureException).toHaveBeenCalled();

    // Feedback form elements are present
    expect(
      screen.getByPlaceholderText('Describe what led to this error...')
    ).toBeInTheDocument();
    expect(screen.getByText('Send Report')).toBeInTheDocument();

    // Type feedback into the textarea
    const textarea = screen.getByPlaceholderText('Describe what led to this error...');
    act(() => {
      fireEvent.change(textarea, { target: { value: 'User feedback' } });
    });

    // Click Send Report
    act(() => {
      fireEvent.click(screen.getByText('Send Report'));
    });

    // Verify thank-you state is displayed after submission
    expect(screen.getByText('Thank you for your feedback!')).toBeInTheDocument();
    expect(
      screen.getByText('Your report helps us improve AfriPay.')
    ).toBeInTheDocument();

    consoleSpy.mockRestore();
  });

  test('renders children when no error', () => {
    render(
      <MemoryRouter>
        <ErrorBoundary key="test-normal">
          <div>Normal content</div>
        </ErrorBoundary>
      </MemoryRouter>
    );
    expect(screen.getByText('Normal content')).toBeInTheDocument();
  });
});
