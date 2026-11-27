import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { DataSaverProvider, useDataSaver, readDataSaverPreference } from './DataSaverContext';

jest.mock('./AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));

function Probe() {
  const { dataSaver, setDataSaver } = useDataSaver();
  return <button onClick={() => setDataSaver(!dataSaver)}>{dataSaver ? 'on' : 'off'}</button>;
}

function setConnection(conn) {
  Object.defineProperty(navigator, 'connection', { value: conn, configurable: true });
}

describe('DataSaverContext (FE-204)', () => {
  beforeEach(() => {
    localStorage.clear();
    setConnection(undefined);
  });

  test('defaults to on when navigator.connection.saveData is true', () => {
    setConnection({ saveData: true, effectiveType: '4g' });
    expect(readDataSaverPreference('u1')).toBe(true);
  });

  test('defaults to on for 2g connections and off otherwise', () => {
    setConnection({ saveData: false, effectiveType: 'slow-2g' });
    expect(readDataSaverPreference('u1')).toBe(true);
    setConnection({ saveData: false, effectiveType: '4g' });
    expect(readDataSaverPreference('u1')).toBe(false);
  });

  test('persists the preference per user and it overrides the default', () => {
    setConnection({ saveData: true });
    render(<DataSaverProvider><Probe /></DataSaverProvider>);
    expect(screen.getByRole('button')).toHaveTextContent('on');
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('button')).toHaveTextContent('off');
    expect(localStorage.getItem('afripay_data_saver_u1')).toBe('off');
    expect(readDataSaverPreference('u1')).toBe(false);
  });
});
