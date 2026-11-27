import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../utils/api';
import { CONTRACT_IDS } from '../config/network';
import { useVisibleInterval } from './useVisibleInterval';

const POLL_MS = 60_000;

/**
 * Poll on-chain status for the named contracts (keys of CONTRACT_IDS).
 * Unconfigured contracts are skipped; a failed poll keeps the last known state.
 * `names` must be a stable (module-level) array.
 */
export default function useContractStates(names) {
  const [states, setStates] = useState({});
  const mounted = useRef(true);
  const configured = names.filter((name) => CONTRACT_IDS?.[name]);

  const load = useCallback(() => {
    names.filter((name) => CONTRACT_IDS?.[name]).forEach((name) => {
      api
        .get(`/contracts/${CONTRACT_IDS[name]}/state`)
        .then(({ data }) => {
          if (mounted.current) setStates((prev) => ({ ...prev, [name]: data }));
        })
        .catch(() => {});
    });
  }, [names]);

  useEffect(() => {
    mounted.current = true;
    load();
    return () => { mounted.current = false; };
  }, [load]);
  useVisibleInterval(load, POLL_MS, { enabled: configured.length > 0 });

  return { states, paused: names.some((name) => states[name]?.paused === true) };
}
