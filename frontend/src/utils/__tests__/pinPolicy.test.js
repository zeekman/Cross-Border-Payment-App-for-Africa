import { getWeakPinReason } from '../pinPolicy';

test.each([
  ['0000', 'repeated'], ['111111', 'repeated'], ['1234', 'sequential'], ['123456', 'sequential'],
  ['9876', 'sequential'], ['2580', 'common'], ['121212', 'common'], ['1990', 'personal'],
  ['8305', null], ['739204', null], ['12', null],
])('%s -> %s', (pin, reason) => expect(getWeakPinReason(pin)).toBe(reason));
