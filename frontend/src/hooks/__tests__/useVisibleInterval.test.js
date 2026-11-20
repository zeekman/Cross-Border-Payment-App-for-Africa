import { renderHook } from '@testing-library/react';
import { useVisibleInterval } from '../useVisibleInterval';

let visibility;

const setVisibility = (state) => {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
};

describe('useVisibleInterval', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    delete document.visibilityState;
  });

  test('calls the callback on every interval while visible', () => {
    const callback = jest.fn();
    renderHook(() => useVisibleInterval(callback, 1000));

    expect(callback).not.toHaveBeenCalled();
    jest.advanceTimersByTime(3000);
    expect(callback).toHaveBeenCalledTimes(3);
  });

  test('does no polling while the document is hidden', () => {
    const callback = jest.fn();
    visibility = 'hidden';
    renderHook(() => useVisibleInterval(callback, 1000));

    jest.advanceTimersByTime(10_000);
    expect(callback).not.toHaveBeenCalled();
  });

  test('stops polling when the tab becomes hidden', () => {
    const callback = jest.fn();
    renderHook(() => useVisibleInterval(callback, 1000));

    jest.advanceTimersByTime(2000);
    expect(callback).toHaveBeenCalledTimes(2);

    setVisibility('hidden');
    jest.advanceTimersByTime(10_000);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  test('refreshes immediately on return, then resumes the interval', () => {
    const callback = jest.fn();
    renderHook(() => useVisibleInterval(callback, 1000));

    setVisibility('hidden');
    jest.advanceTimersByTime(5000);
    expect(callback).not.toHaveBeenCalled();

    setVisibility('visible');
    expect(callback).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(2000);
    expect(callback).toHaveBeenCalledTimes(3);
  });

  test('skips the immediate refresh when runOnVisible is false', () => {
    const callback = jest.fn();
    renderHook(() => useVisibleInterval(callback, 1000, { runOnVisible: false }));

    setVisibility('hidden');
    setVisibility('visible');
    expect(callback).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1000);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  test('mounted while hidden: first runs when the page becomes visible', () => {
    const callback = jest.fn();
    visibility = 'hidden';
    renderHook(() => useVisibleInterval(callback, 1000));

    setVisibility('visible');
    expect(callback).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1000);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  test('a redundant visible event does not start a second timer', () => {
    const callback = jest.fn();
    renderHook(() => useVisibleInterval(callback, 1000));

    setVisibility('visible');
    setVisibility('visible');
    expect(callback).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1000);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  test('uses the latest callback without restarting the timer', () => {
    const first = jest.fn();
    const second = jest.fn();
    const { rerender } = renderHook(({ cb }) => useVisibleInterval(cb, 1000), {
      initialProps: { cb: first },
    });

    jest.advanceTimersByTime(500);
    rerender({ cb: second });
    jest.advanceTimersByTime(500);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  test('does nothing when disabled or when ms is null', () => {
    const callback = jest.fn();
    renderHook(() => useVisibleInterval(callback, 1000, { enabled: false }));
    renderHook(() => useVisibleInterval(callback, null));

    setVisibility('hidden');
    setVisibility('visible');
    jest.advanceTimersByTime(10_000);
    expect(callback).not.toHaveBeenCalled();
  });

  test('cleans up the timer and listener on unmount', () => {
    const callback = jest.fn();
    const { unmount } = renderHook(() => useVisibleInterval(callback, 1000));

    unmount();
    setVisibility('hidden');
    setVisibility('visible');
    jest.advanceTimersByTime(10_000);
    expect(callback).not.toHaveBeenCalled();
  });
});
