import { useRef, useState, useCallback } from 'react';

const THRESHOLD = 80; // px of pull needed to trigger refresh

export function usePullToRefresh(onRefresh) {
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef(null);

  const onTouchStart = useCallback((e) => {
    // Only activate when scrolled to the top
    if (window.scrollY === 0) {
      startY.current = e.touches[0].clientY;
    }
  }, []);

  const onTouchMove = useCallback((e) => {
    if (startY.current === null) return;
    const delta = e.touches[0].clientY - startY.current;
    if (delta > 0) {
      // Dampen the pull so it feels natural
      setPullDistance(Math.min(delta * 0.4, THRESHOLD));
    }
  }, []);

  const onTouchEnd = useCallback(async () => {
    if (startY.current === null) return;
    startY.current = null;

    if (pullDistance >= THRESHOLD) {
      setRefreshing(true);
      setPullDistance(0);
      try {
        await onRefresh();
      } finally {
        setRefreshing(false);
      }
    } else {
      setPullDistance(0);
    }
  }, [pullDistance, onRefresh]);

  return { pullDistance, refreshing, onTouchStart, onTouchMove, onTouchEnd };
}
