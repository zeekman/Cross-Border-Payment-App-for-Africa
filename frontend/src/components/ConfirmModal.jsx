import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, X } from 'lucide-react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const getFocusable = (root) =>
  root ? Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR)) : [];

/**
 * Accessible confirmation dialog (FE-140).
 *
 * - Exposed as role="dialog" + aria-modal, labelled by its title and described by its message.
 * - On open, focus moves to the least-destructive action (Cancel); Tab / Shift+Tab stay inside
 *   the dialog; on close, focus returns to whatever element opened it.
 * - Escape and a click on the backdrop both cancel (unless an action is in flight).
 * - Everything else under <body> is marked `inert` while the dialog is open so it can't be
 *   reached by keyboard or assistive technology.
 */
export default function ConfirmModal({ isOpen, onClose, onConfirm, title, message, confirmLabel, confirmVariant, loading, children }) {
  const titleId = useId();
  const messageId = useId();
  const rootRef = useRef(null);
  const panelRef = useRef(null);
  const cancelRef = useRef(null);

  // While open: make the rest of the page inert and move focus into the dialog.
  // On close: lift inert first (an inert element can't take focus), then restore focus.
  useEffect(() => {
    if (!isOpen) return undefined;
    const previouslyFocused = document.activeElement;
    const root = rootRef.current;

    const siblings = Array.from(document.body.children).filter(
      (el) => el !== root && !el.hasAttribute('inert')
    );
    siblings.forEach((el) => el.setAttribute('inert', ''));

    const initial = cancelRef.current && !cancelRef.current.disabled ? cancelRef.current : panelRef.current;
    initial?.focus();

    return () => {
      siblings.forEach((el) => el.removeAttribute('inert'));
      if (previouslyFocused && typeof previouslyFocused.focus === 'function' && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const cancel = () => {
    if (!loading) onClose?.();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      cancel();
      return;
    }

    if (e.key !== 'Tab') return;

    const focusable = getFocusable(panelRef.current);
    if (focusable.length === 0) {
      e.preventDefault();
      panelRef.current?.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    const outside = !panelRef.current.contains(active) || active === panelRef.current;

    if (e.shiftKey && (active === first || outside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || outside)) {
      e.preventDefault();
      first.focus();
    }
  };

  const handleBackdropMouseDown = (e) => {
    if (e.target === e.currentTarget) cancel();
  };

  const confirmButtonClass =
    confirmVariant === 'danger'
      ? 'bg-red-600 hover:bg-red-700'
      : 'bg-primary-500 hover:bg-primary-600';

  return createPortal(
    // Keyboard handling sits on the backdrop so it covers the whole dialog;
    // Escape is the keyboard equivalent of clicking the backdrop.
    <div
      ref={rootRef}
      className="fixed inset-0 bg-black bg-opacity-75 z-50 flex items-center justify-center p-4"
      onMouseDown={handleBackdropMouseDown}
      onKeyDown={handleKeyDown}
      data-testid="confirm-modal-backdrop"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={message ? messageId : undefined}
        tabIndex={-1}
        className="bg-gray-900 rounded-2xl w-full max-w-sm overflow-hidden focus:outline-none"
      >
        <div className="flex items-center justify-between bg-gray-800 px-6 py-4">
          <div className="flex items-center gap-2">
            <AlertTriangle size={20} className="text-red-400" aria-hidden="true" />
            <h3 id={titleId} className="text-lg font-semibold text-white">{title}</h3>
          </div>
          <button
            type="button"
            onClick={cancel}
            disabled={loading}
            aria-label="Close"
            className="text-gray-400 hover:text-white transition-colors disabled:opacity-50"
          >
            <X size={24} aria-hidden="true" />
          </button>
        </div>

        <div className="px-6 py-6">
          <p id={messageId} className="text-sm text-gray-300 leading-relaxed">{message}</p>

          {/* Optional extra content (e.g. secondary action links) */}
          {children}

          <div className="flex gap-3 pt-6">
            <button
              ref={cancelRef}
              type="button"
              onClick={cancel}
              disabled={loading}
              className="flex-1 bg-gray-800 hover:bg-gray-700 rounded-xl py-3 text-white font-medium transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={loading}
              aria-busy={loading ? 'true' : undefined}
              className={`flex-1 ${confirmButtonClass} rounded-xl py-3 text-white font-semibold transition-colors flex items-center justify-center gap-2 disabled:opacity-50`}
            >
              {loading ? (
                <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" role="status" aria-label="Loading" />
              ) : (
                confirmLabel || 'Confirm'
              )}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
