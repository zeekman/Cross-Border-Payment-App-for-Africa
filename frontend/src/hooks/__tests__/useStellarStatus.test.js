import { renderHook, waitFor, act } from '@testing-library/react';
import { useStellarStatus } from '../useStellarStatus';

// Mock fetch
global.fetch = jest.fn();

// Mock localStorage
const localStorageMock = {
  getItem: jest.fn(),
  setItem: jest.fn(),
  clear: jest.fn(),
};
Object.defineProperty(window, 'localStorage', { value: localStorageMock });

describe('useStellarStatus', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorageMock.getItem.mockReturnValue(null);
    fetch.mockClear();
  });

  test('returns loading state initially', () => {
    fetch.mockImplementation(() => new Promise(() => {})); // Never resolves
    
    const { result } = renderHook(() => useStellarStatus());
    
    expect(result.current.loading).toBe(true);
    expect(result.current.status).toBe(null);
    expect(result.current.error).toBe(null);
    expect(result.current.isDegraded).toBe(false);
  });

  test('fetches status and returns operational state', async () => {
    const mockStatus = {
      status: 'All Systems Operational',
      components: []
    };
    
    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockStatus)
    });
    
    const { result } = renderHook(() => useStellarStatus());
    
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    
    expect(result.current.status).toEqual(mockStatus);
    expect(result.current.isDegraded).toBe(false);
    expect(result.current.error).toBe(null);
  });

  test('detects degraded status', async () => {
    const mockStatus = {
      status: 'Partial System Outage',
      components: []
    };
    
    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockStatus)
    });
    
    const { result } = renderHook(() => useStellarStatus());
    
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    
    expect(result.current.status).toEqual(mockStatus);
    expect(result.current.isDegraded).toBe(true);
  });

  test('handles fetch error gracefully', async () => {
    fetch.mockRejectedValue(new Error('Network error'));
    
    const { result } = renderHook(() => useStellarStatus());
    
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    
    expect(result.current.error).toBe('Network error');
    expect(result.current.status).toBe(null);
    expect(result.current.isDegraded).toBe(false);
  });

  test('uses cached data when available', async () => {
    const cachedData = {
      status: 'All Systems Operational',
      components: []
    };
    
    localStorageMock.getItem.mockReturnValue(JSON.stringify({
      data: cachedData,
      timestamp: Date.now()
    }));
    
    const { result } = renderHook(() => useStellarStatus());
    
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    
    expect(result.current.status).toEqual(cachedData);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('ignores expired cache', async () => {
    const cachedData = {
      status: 'All Systems Operational',
      components: []
    };
    
    localStorageMock.getItem.mockReturnValue(JSON.stringify({
      data: cachedData,
      timestamp: Date.now() - 10 * 60 * 1000 // 10 minutes ago
    }));
    
    const mockStatus = {
      status: 'Partial System Outage',
      components: []
    };
    
    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockStatus)
    });
    
    const { result } = renderHook(() => useStellarStatus());
    
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    
    expect(result.current.status).toEqual(mockStatus);
    expect(fetch).toHaveBeenCalled();
  });

  test('refetch function bypasses cache', async () => {
    const cachedData = {
      status: 'All Systems Operational',
      components: []
    };
    
    localStorageMock.getItem.mockReturnValue(JSON.stringify({
      data: cachedData,
      timestamp: Date.now()
    }));
    
    const mockStatus = {
      status: 'Partial System Outage',
      components: []
    };
    
    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockStatus)
    });
    
    const { result } = renderHook(() => useStellarStatus());
    
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    
    // Initial load uses cache
    expect(result.current.status).toEqual(cachedData);
    
    // Refetch should bypass cache
    await act(async () => {
      await result.current.refetch();
    });
    
    expect(fetch).toHaveBeenCalled();
  });

  test('handles HTTP error responses', async () => {
    fetch.mockResolvedValue({
      ok: false,
      status: 500
    });
    
    const { result } = renderHook(() => useStellarStatus());
    
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    
    expect(result.current.error).toBe('HTTP 500');
    expect(result.current.isDegraded).toBe(false);
  });
});
