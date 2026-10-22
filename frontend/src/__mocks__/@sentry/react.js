import { vi } from 'vitest';

export const captureException = vi.fn(() => 'test-event-id');
export const captureMessage = vi.fn();
export const captureUserFeedback = vi.fn();
export const setUser = vi.fn();
export const withScope = vi.fn();
export const init = vi.fn();
export const withProfiler = (component) => component;
export const ErrorBoundary = ({ children }) => children;
