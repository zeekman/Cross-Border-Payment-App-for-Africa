import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import Profile from './Profile';
import api from '../utils/api';
import toast from 'react-hot-toast';

// Mock api
jest.mock('../utils/api', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
    delete: jest.fn(),
  },
}));

// Mock useAuth
jest.mock('../context/AuthContext', () => ({
  ...jest.requireActual('../context/AuthContext'),
  useAuth: () => ({
    user: { full_name: 'John Doe', email: 'john@test.com', wallet_address: 'GC...123' },
    logout: jest.fn(),
  }),
}));

// Mock toast
jest.mock('react-hot-toast');

// Global timeout for all tests in this file
jest.setTimeout(15000);

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

  test('fetches and displays contacts on mount', async () => {
    const mockContacts = [
      { id: 1, name: 'Alice', wallet_address: 'GA123' },
      { id: 2, name: 'Bob', wallet_address: 'GB456' },
    ];
    // Backend returns { contacts: [...] }
    api.get.mockResolvedValueOnce({ data: { contacts: mockContacts } });

    await renderProfile();

    expect(api.get).toHaveBeenCalledWith('/wallet/contacts');
    
    await waitFor(() => {
      expect(screen.getByText('Alice')).toBeInTheDocument();
      expect(screen.getByText('Bob')).toBeInTheDocument();
    });
  });

  test('adds a new contact successfully', async () => {
    api.get.mockResolvedValueOnce({ data: { contacts: [] } });
    const newContact = { id: 3, name: 'Charlie', wallet_address: 'GC789' };
    // Backend returns { contact: { ... } }
    api.post.mockResolvedValueOnce({ data: { contact: newContact } });

    await renderProfile();

    // Open add contact form
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
    api.get.mockResolvedValueOnce({ data: { contacts: mockContacts } });
    api.delete.mockResolvedValueOnce({});

    await renderProfile();

    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());

    const deleteBtn = screen.getByLabelText('Delete contact');
    fireEvent.click(deleteBtn);

    expect(window.confirm).toHaveBeenCalledWith('Are you sure you want to delete this contact?');
    
    await waitFor(() => {
      expect(screen.queryByText('Alice')).not.toBeInTheDocument();
    });
    expect(api.delete).toHaveBeenCalledWith('/wallet/contacts/1');
    expect(toast.success).toHaveBeenCalledWith('Contact deleted');
  });

  test('handles delete failure', async () => {
    const mockContacts = [{ id: 1, name: 'Alice', wallet_address: 'GA123' }];
    api.get.mockResolvedValueOnce({ data: { contacts: mockContacts } });
    api.delete.mockRejectedValueOnce(new Error('Delete failed'));

    await renderProfile();

    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());

    const deleteBtn = screen.getByLabelText('Delete contact');
    fireEvent.click(deleteBtn);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to delete contact');
    });
    // Alice should still be there
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });
});
