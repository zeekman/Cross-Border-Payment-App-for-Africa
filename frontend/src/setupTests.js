import '@testing-library/jest-dom/vitest';

// Testing Library's waitFor() only advances fake timers when it finds a global
// `jest` object. Point it at Vitest's timers so tests using vi.useFakeTimers()
// behave as they did under CRA's Jest.
globalThis.jest = {
  advanceTimersByTime: (ms) => vi.advanceTimersByTime(ms),
};
