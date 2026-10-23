import React from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ActionButtons from '../ActionButtons';
import { baseProps } from '../testProps';

jest.mock('../../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
jest.mock('react-hot-toast', () => ({ __esModule: true, default: { success: jest.fn(), error: jest.fn() } }));

test('ActionButtons renders without crashing', () => {
  const { container } = render(
    <MemoryRouter>
      <ActionButtons {...baseProps} />
    </MemoryRouter>
  );
  expect(container).toBeTruthy();
});
