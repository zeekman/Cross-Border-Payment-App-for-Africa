import { useState, useCallback } from 'react';

const HEX_64_REGEX = /^[0-9a-fA-F]{64}$/;
const HEX_CHARS_REGEX = /^[0-9a-fA-F]*$/;

export const TEXT_MEMO_MAX_BYTES = 28;

export function getMemoByteLength(memoValue) {
  if (!memoValue) return 0;
  return new TextEncoder().encode(memoValue).length;
}

export function useMemoValidation() {
  const [memoError, setMemoError] = useState('');

  const validateMemo = useCallback((memoType, memoValue) => {
    if (memoType === 'text') {
      const bytes = getMemoByteLength(memoValue);
      if (bytes > TEXT_MEMO_MAX_BYTES) {
        setMemoError(
          `Memo must be at most ${TEXT_MEMO_MAX_BYTES} bytes (UTF-8) — ${bytes} bytes used`
        );
        return false;
      }
      setMemoError('');
      return true;
    }

    if (memoType !== 'hash' && memoType !== 'return') {
      setMemoError('');
      return true;
    }

    if (!memoValue) {
      setMemoError('Memo hash must be exactly 64 hexadecimal characters (0-9, a-f)');
      return false;
    }

    if (!HEX_CHARS_REGEX.test(memoValue)) {
      setMemoError('Memo hash must contain only hexadecimal characters (0-9, a-f)');
      return false;
    }

    if (!HEX_64_REGEX.test(memoValue)) {
      const len = memoValue.length;
      const remaining = 64 - len;
      if (len < 64) {
        setMemoError(
          `Memo hash must be exactly 64 hexadecimal characters (0-9, a-f) — ${remaining} more needed`
        );
      } else {
        setMemoError(
          `Memo hash must be exactly 64 hexadecimal characters (0-9, a-f) — ${len - 64} too many`
        );
      }
      return false;
    }

    setMemoError('');
    return true;
  }, []);

  const getMemoPlaceholder = useCallback((memoType) => {
    if (memoType === 'hash' || memoType === 'return') {
      return '64 hexadecimal characters (e.g. a3f1...c9d2)';
    }
    if (memoType === 'text') return `Up to ${TEXT_MEMO_MAX_BYTES} bytes (UTF-8)`;
    if (memoType === 'id') return 'Unsigned 64-bit integer';
    return 'Optional memo';
  }, []);

  const isMemoValid = useCallback((memoType, memoValue) => {
    if (memoType === 'text') {
      return getMemoByteLength(memoValue) <= TEXT_MEMO_MAX_BYTES;
    }
    if (memoType !== 'hash' && memoType !== 'return') return true;
    return HEX_64_REGEX.test(memoValue || '');
  }, []);

  return {
    memoError,
    validateMemo,
    getMemoPlaceholder,
    isMemoValid,
    setMemoError,
    getMemoByteLength,
    textMemoMaxBytes: TEXT_MEMO_MAX_BYTES,
  };
}
