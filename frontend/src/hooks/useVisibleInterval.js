/**
 * useVisibleInterval
 *
 * Like setInterval, but only ticks while the page is visible. A hidden tab or
 * backgrounded PWA stops polling (saving mobile data, battery and Horizon rate
 * limit budget), and returning to the page refreshes immediately instead of
 * waiting out the rest of the interval.
 *
 *   useVisibleInterval(refresh, 15_000);
 *   useVisibleInterval(poll, 5_000, { runOnVisible: false, enabled: isActive });
 *
 * Options:
 *  - runOnVisible : call `callback` right away when the page becomes visible
 *                   again after being hidden (default true). Never fires while
 *                   the page is hidden or when the page was already visible.
 *  - enabled      : set false to pause polling entirely (default true).
 *
 * `callback` is read through a ref, so passing a fresh closure each render does
 * not restart the timer. Passing `ms` of null/undefined also disables polling.
 */

import { useEffect, useRef } from 'react';

const isHidden = () =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden';

/**
 * @param {() => void} callback
 * @param {number | null | undefined} ms
 * @param {{ runOnVisible?: boolean, enabled?: boolean }} [options]
 */
export function useVisibleInterval(
  callback,
  ms,
  { runOnVisible = true, enabled = true } = {}
) {
  const savedCallback = useRef(callback);

  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!enabled || ms === null || ms === undefined) return undefined;

    let timerId = null;
    const tick = () => savedCallback.current();
    const start = () => {
      if (timerId === null) timerId = setInterval(tick, ms);
    };
    const stop = () => {
      if (timerId !== null) {
        clearInterval(timerId);
        timerId = null;
      }
    };

    const handleVisibilityChange = () => {
      if (isHidden()) {
        stop();
      } else if (timerId === null) {
        // Only on a real hidden -> visible transition (no timer was running).
        if (runOnVisible) tick();
        start();
      }
    };

    if (!isHidden()) start();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      stop();
    };
  }, [ms, runOnVisible, enabled]);
}

export default useVisibleInterval;
