import { useCallback, useRef, useState } from 'react';
import PINVerificationModal from '../components/PINVerificationModal';

export default function useStepUp(details = {}) {
  const [isOpen, setIsOpen] = useState(false);
  const resolveRef = useRef(null);

  const requestStepUp = useCallback(() => new Promise((resolve) => {
    resolveRef.current = resolve;
    setIsOpen(true);
  }), []);

  const finish = useCallback((token) => {
    setIsOpen(false);
    resolveRef.current?.(token || null);
    resolveRef.current = null;
  }, []);

  const modal = (
    <PINVerificationModal
      isOpen={isOpen}
      onClose={() => finish(null)}
      onSuccess={finish}
      amount={details.amount}
      recipient={details.recipient}
    />
  );

  return { requestStepUp, stepUpModal: modal };
}