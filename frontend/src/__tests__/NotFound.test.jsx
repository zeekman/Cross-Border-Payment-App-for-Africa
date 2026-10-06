import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import App from '../App';

vi.mock('@sentry/react', () => ({
  addBreadcrumb: vi.fn(),
}));

describe('NotFound catch-all route', () => {
  it('renders the 404 page for an unknown path', () => {
    render(
      <MemoryRouter initialEntries={['/this/route/does/not/exist']}>
        <App />
      </MemoryRouter>
    );

    expect(screen.getByText(/404/i)).toBeInTheDocument();
  });

  it('provides a link back home', () => {
    render(
      <MemoryRouter initialEntries={['/nope']}>
        <App />
      </MemoryRouter>
    );

    const homeLink = screen.getByRole('link', { name: /home|dashboard/i });
    expect(homeLink).toBeInTheDocument();
    expect(homeLink).toHaveAttribute('href', '/');
  });
});
