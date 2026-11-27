import React, { useCallback } from 'react';
import { normalizeAmount } from '../utils/amount';

/**
 * Text-based amount input that:
 * - normalizes `,` to `.`
 * - allows only digits plus one decimal separator
 * - caps at 7 decimals
 * - blocks exponent/sign characters
 * - ignores mouse-wheel events so scrolling never changes the value
 * - exposes the value as a string via onChange
 */
export default function AmountInput({
  value = '',
  onChange,
  onBlur,
  className,
  placeholder,
  disabled,
  id,
  name,
  ...rest
}) {
  const handleChange = useCallback(
    (event) => {
      const normalized = normalizeAmount(event.target.value);
      if (onChange) onChange(normalized);
    },
    [onChange]
  );

  const handleWheel = useCallback((event) => {
    // Prevent scroll from mutating the field; blur to stop page scroll capture.
    event.currentTarget.blur();
  }, []);

  const handleKeyDown = useCallback((event) => {
    // Block exponent and sign characters explicitly.
    if (['e', 'E', '+', '-'].includes(event.key)) {
      event.preventDefault();
    }
  }, []);

  return (
    <input
      id={id}
      name={name}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      className={className}
      placeholder={placeholder}
      disabled={disabled}
      value={value}
      onChange={handleChange}
      onBlur={onBlur}
      onWheel={handleWheel}
      onKeyDown={handleKeyDown}
      {...rest}
    />
  );
}
