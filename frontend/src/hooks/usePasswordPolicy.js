import { useEffect, useState } from 'react';
import { getPasswordPolicy, loadPasswordPolicy } from '../utils/passwordPolicy';

/**
 * Returns the password policy served by the backend (single source of truth).
 * Starts with the cached/default policy so the first render is synchronous,
 * then re-renders with the server-provided policy once the fetch resolves.
 */
export function usePasswordPolicy() {
  const [policy, setPolicy] = useState(getPasswordPolicy);

  useEffect(() => {
    let mounted = true;
    loadPasswordPolicy().then((loaded) => {
      if (mounted) setPolicy(loaded);
    });
    return () => {
      mounted = false;
    };
  }, []);

  return policy;
}
