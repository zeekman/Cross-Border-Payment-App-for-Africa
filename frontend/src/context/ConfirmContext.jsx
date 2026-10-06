import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ConfirmModal from '../components/ConfirmModal';

const ConfirmContext = createContext(() => Promise.resolve(false));

/**
 * Promise-based replacement for the native confirm dialog backed by ConfirmModal.
 *   const confirm = useConfirm();
 *   if (!(await confirm(message, { title, confirmLabel, danger: true }))) return;
 */
export function ConfirmProvider({ children }) {
  const { t } = useTranslation();
  const [state, setState] = useState(null);
  const resolver = useRef(null);

  const confirm = useCallback((message, options = {}) => new Promise((resolve) => {
    resolver.current = resolve;
    setState({ message, ...options });
  }), []);

  const close = (result) => {
    resolver.current?.(result);
    resolver.current = null;
    setState(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmModal
        isOpen={!!state}
        title={state?.title || t('common.confirm_title', 'Are you sure?')}
        message={state?.message}
        confirmLabel={state?.confirmLabel || t('common.confirm', 'Confirm')}
        confirmVariant={state?.danger === false ? undefined : 'danger'}
        onClose={() => close(false)}
        onConfirm={() => close(true)}
      />
    </ConfirmContext.Provider>
  );
}

export const useConfirm = () => useContext(ConfirmContext);
