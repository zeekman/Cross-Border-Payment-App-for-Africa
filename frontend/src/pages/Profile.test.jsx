import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import Profile from './Profile';
import api from '../utils/api';
import toast from 'react-hot-toast';

jest.mock('../utils/api', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
    delete: jest.fn(),
  },
}));

jest.mock('../context/AuthContext', () => ({
  ...jest.requireActual('../context/AuthContext'),
  useAuth: () => ({
    user: { full_name: 'John Doe', email: 'john@test.com', wallet_address: 'GC...123' },
    logout: jest.fn(),
  }),
}));

jest.mock('react-hot-toast');

jest.setTimeout(15000);

// The component fires api.get in this order on mount:
//   1. /wallet/trustlines  (first useEffect)
//   2. /wallet/contacts    (second useEffect)
//   3. /auth/activity      (second useEffect)
function mockMountCalls({ contacts = [], trustlines = [], activity = [] } = {}) {
  api.get
    .mockResolvedValueOnce({ data: { trustlines } })
    .mockResolvedValueOnce({ data: { contacts } })
    .mockResolvedValueOnce({ data: { activity } });
}

const renderProfile = async () => {
  await act(async () => {
    render(
      <BrowserRouter>
        <Profile />
      </BrowserRouter>
    );
  });
};

describe('Profile Component', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.confirm = jest.fn(() => true);
  });

  test('shows loading state while contacts are being fetched', () => {
    api.get.mockReturnValue(new Promise(() => {})); // never resolves
    render(
      <BrowserRouter>
        <Profile />
      </BrowserRouter>
    );
    expect(screen.getByTestId('contacts-loading')).toBeInTheDocument();
  });

  test('fetches and displays contacts on mount', async () => {
    const mockContacts = [
      { id: 1, name: 'Alice', wallet_address: 'GA123' },
      { id: 2, name: 'Bob', wallet_address: 'GB456' },
    ];
    mockMountCalls({ contacts: mockContacts });

    await renderProfile();

    expect(api.get).toHaveBeenCalledWith('/wallet/contacts');
    await waitFor(() => {
      expect(screen.getByText('Alice')).toBeInTheDocument();
      expect(screen.getByText('Bob')).toBeInTheDocument();
    });
  });

  test('shows empty state when no contacts returned', async () => {
    mockMountCalls({ contacts: [] });

    await renderProfile();

    await waitFor(() => {
      expect(screen.getByText('No contacts yet')).toBeInTheDocument();
    });
  });

  test('shows error toast when contacts fetch fails', async () => {
    api.get
      .mockResolvedValueOnce({ data: { trustlines: [] } })
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({ data: { activity: [] } });

    await renderProfile();

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to load contacts');
    });
  });

  test('adds a new contact successfully', async () => {
    mockMountCalls({ contacts: [] });
    const newContact = { id: 3, name: 'Charlie', wallet_address: 'GC789' };
    api.post.mockResolvedValueOnce({ data: { contact: newContact } });

    await renderProfile();

    fireEvent.click(screen.getByText(/Add/i));
    fireEvent.change(screen.getByPlaceholderText('Contact name'), { target: { value: 'Charlie' } });
    fireEvent.change(screen.getByPlaceholderText('G... wallet address'), { target: { value: 'GC789' } });
    fireEvent.click(screen.getByText('Save Contact'));

    await waitFor(() => {
      expect(screen.getByText('Charlie')).toBeInTheDocument();
    });
    expect(toast.success).toHaveBeenCalledWith('Contact added');
  });

  test('deletes a contact successfully after confirmation', async () => {
    const mockContacts = [{ id: 1, name: 'Alice', wallet_address: 'GA123' }];
    mockMountCalls({ contacts: mockContacts });
    api.delete.mockResolvedValueOnce({});

    await renderProfile();

    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Delete contact'));

    expect(window.confirm).toHaveBeenCalledWith('Are you sure you want to delete this contact?');
    await waitFor(() => {
      expect(screen.queryByText('Alice')).not.toBeInTheDocument();
    });
    expect(api.delete).toHaveBeenCalledWith('/wallet/contacts/1');
    expect(toast.success).toHaveBeenCalledWith('Contact deleted');
  });

  test('handles delete failure', async () => {
    const mockContacts = [{ id: 1, name: 'Alice', wallet_address: 'GA123' }];
    mockMountCalls({ contacts: mockContacts });
    api.delete.mockRejectedValueOnce(new Error('Delete failed'));

    await renderProfile();

    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Delete contact'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to delete contact');
    });
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });
});
