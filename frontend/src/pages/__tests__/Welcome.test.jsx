import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

jest.mock('../../api', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
  },
}));

jest.mock('react-router-dom', () => {
  const actual = jest.requireActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const mockNavigate = jest.fn();

import api from '../../api';
import Welcome from '../Welcome';

const renderWelcome = () =>
  render(
    <MemoryRouter>
      <Welcome />
    </MemoryRouter>
  );

describe('Welcome page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the welcome page on initial load', () => {
    renderWelcome();

    expect(document.body.textContent).toBeTruthy();
    expect(screen.getByRole('button', { name: /next|continue|get started|skip/i })).toBeInTheDocument();
  });

  it('renders without making any API calls on mount', () => {
    renderWelcome();

    expect(api.get).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
    expect(api.put).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('advances to the next slide when the next button is clicked', () => {
    renderWelcome();

    const nextButton = screen.getByRole('button', { name: /next|continue/i });
    const before = document.body.textContent;

    fireEvent.click(nextButton);

    expect(document.body.textContent).not.toBe(before);
  });

  it('navigates to the login page when the get started CTA is clicked', async () => {
    renderWelcome();

    const cta = screen.getByRole('button', { name: /get started|skip|login|sign in/i });
    fireEvent.click(cta);

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalled();
    });
  });

  it('does not throw when navigating through all slides', () => {
    renderWelcome();

    const buttons = screen.getAllByRole('button');
    buttons.forEach((button) => {
      expect(() => fireEvent.click(button)).not.toThrow();
    });
  });
});