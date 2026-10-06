import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import QRScanner, { detectPlatform } from './QRScanner';
import toast from 'react-hot-toast';

// Mock dependencies
vi.mock('react-hot-toast');
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key) => key,
  }),
}));

vi.mock('react-qr-reader', () => ({
  QrReader: ({ onResult, onError }) => (
    <div data-testid="qr-reader">
      <button
        data-testid="mock-scan-success"
        onClick={() => onResult({ text: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567890ABCDEFGHIJKLMNOP' })}
      >
        Scan Success
      </button>
      <button
        data-testid="mock-scan-invalid"
        onClick={() => onResult({ text: 'INVALID' })}
      >
        Scan Invalid
      </button>
      <button
        data-testid="mock-error-permission"
        onClick={() => onError({ name: 'NotAllowedError', message: 'Permission denied' })}
      >
        Permission Error
      </button>
      <button
        data-testid="mock-error-no-camera"
        onClick={() => onError({ name: 'NotFoundError', message: 'No camera' })}
      >
        No Camera Error
      </button>
    </div>
  ),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

function mockPermissionDenied() {
  global.navigator.permissions = {
    query: vi.fn().mockResolvedValue({
      state: 'denied',
      onchange: null,
    }),
  };
}

function mockPermissionGranted() {
  global.navigator.permissions = {
    query: vi.fn().mockResolvedValue({
      state: 'granted',
      onchange: null,
    }),
  };
}

function mockCameraAvailable() {
  global.navigator.mediaDevices = {
    enumerateDevices: vi.fn().mockResolvedValue([
      { kind: 'videoinput', label: 'Back Camera' },
    ]),
    getUserMedia: vi.fn().mockResolvedValue({
      getTracks: () => [{ stop: vi.fn() }],
    }),
  };
}

/** Replace navigator.userAgent via Object.defineProperty. Returns a reset fn. */
function setUserAgent(ua) {
  const original = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent');
  Object.defineProperty(window.navigator, 'userAgent', {
    value: ua,
    writable: true,
    configurable: true,
  });
  return () => {
    if (original) {
      Object.defineProperty(window.navigator, 'userAgent', original);
    }
  };
}

/** Override navigator.standalone (iOS PWA flag). Returns a reset fn. */
function setIOSStandalone(value) {
  const original = Object.getOwnPropertyDescriptor(window.navigator, 'standalone');
  Object.defineProperty(window.navigator, 'standalone', {
    value,
    writable: true,
    configurable: true,
  });
  return () => {
    if (original) {
      Object.defineProperty(window.navigator, 'standalone', original);
    } else {
      delete window.navigator.standalone;
    }
  };
}

// ─── Unit tests for detectPlatform() ────────────────────────────────────────

describe('detectPlatform()', () => {
  let resetUA;
  let resetStandalone;

  afterEach(() => {
    resetUA?.();
    resetStandalone?.();
    // Reset matchMedia to non-standalone
    window.matchMedia = vi.fn().mockReturnValue({ matches: false });
  });

  it('returns ios_pwa on iOS with navigator.standalone=true', () => {
    resetUA = setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
    );
    resetStandalone = setIOSStandalone(true);
    expect(detectPlatform()).toBe('ios_pwa');
  });

  it('returns ios_safari on iPhone without standalone', () => {
    resetUA = setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'
    );
    resetStandalone = setIOSStandalone(false);
    expect(detectPlatform()).toBe('ios_safari');
  });

  it('returns ios_safari on iPad', () => {
    resetUA = setUserAgent(
      'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
    );
    resetStandalone = setIOSStandalone(false);
    expect(detectPlatform()).toBe('ios_safari');
  });

  it('returns android_pwa on Android Chrome with standalone display-mode', () => {
    resetUA = setUserAgent(
      'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36'
    );
    window.matchMedia = vi.fn().mockReturnValue({ matches: true });
    expect(detectPlatform()).toBe('android_pwa');
  });

  it('returns android_chrome on Android Chrome without standalone', () => {
    resetUA = setUserAgent(
      'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36'
    );
    window.matchMedia = vi.fn().mockReturnValue({ matches: false });
    expect(detectPlatform()).toBe('android_chrome');
  });

  it('returns desktop_firefox on Firefox desktop', () => {
    resetUA = setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0'
    );
    window.matchMedia = vi.fn().mockReturnValue({ matches: false });
    expect(detectPlatform()).toBe('desktop_firefox');
  });

  it('returns desktop_chrome on Chrome desktop', () => {
    resetUA = setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
    );
    window.matchMedia = vi.fn().mockReturnValue({ matches: false });
    expect(detectPlatform()).toBe('desktop_chrome');
  });
});

// ─── Component integration tests ────────────────────────────────────────────

describe('QRScanner', () => {
  const mockOnClose = vi.fn();
  const mockOnScan = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockCameraAvailable();
    // Default: permission prompt (not denied)
    global.navigator.permissions = {
      query: vi.fn().mockResolvedValue({
        state: 'prompt',
        onchange: null,
      }),
    };
    // Default: no standalone
    window.matchMedia = vi.fn().mockReturnValue({ matches: false });
  });

  it('should not render when isOpen is false', () => {
    const { container } = render(
      <QRScanner isOpen={false} onClose={mockOnClose} onScan={mockOnScan} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('should render scanner when isOpen is true and camera available', async () => {
    render(<QRScanner isOpen={true} onClose={mockOnClose} onScan={mockOnScan} />);

    await waitFor(() => {
      expect(screen.getByTestId('qr-reader')).toBeInTheDocument();
    });
  });

  // ── Successful scan path ───────────────────────────────────────────────────

  describe('Successful scan path', () => {
    it('should handle successful QR scan with valid Stellar address', async () => {
      render(<QRScanner isOpen={true} onClose={mockOnClose} onScan={mockOnScan} />);

      await waitFor(() => {
        expect(screen.getByTestId('qr-reader')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('mock-scan-success'));

      await waitFor(() => {
        expect(mockOnScan).toHaveBeenCalledWith('GABCDEFGHIJKLMNOPQRSTUVWXYZ234567890ABCDEFGHIJKLMNOP');
        expect(mockOnClose).toHaveBeenCalled();
        expect(toast.success).toHaveBeenCalledWith('send.qr_scanned');
      });
    });

    it('should reject invalid QR code content', async () => {
      render(<QRScanner isOpen={true} onClose={mockOnClose} onScan={mockOnScan} />);

      await waitFor(() => {
        expect(screen.getByTestId('qr-reader')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('mock-scan-invalid'));

      await waitFor(() => {
        expect(mockOnScan).not.toHaveBeenCalled();
        expect(toast.error).toHaveBeenCalledWith('send.qr_invalid');
      });
    });
  });

  // ── Per-platform permission-denied UI ─────────────────────────────────────

  describe('Per-platform permission-denied UI', () => {
    /**
     * Shared assertions: when the permission is denied the manual fallback
     * input must always be visible and prominent, regardless of platform.
     */
    async function assertManualFallbackVisible() {
      await waitFor(() => {
        expect(
          screen.getByPlaceholderText('send.enter_stellar_address')
        ).toBeInTheDocument();
        expect(screen.getByText('send.camera_access_denied')).toBeInTheDocument();
      });
    }

    describe('iOS Safari', () => {
      let resetUA;
      let resetStandalone;

      beforeEach(() => {
        resetUA = setUserAgent(
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'
        );
        resetStandalone = setIOSStandalone(false);
        mockPermissionDenied();
      });

      afterEach(() => {
        resetUA();
        resetStandalone();
      });

      it('shows fallback + manual entry on iOS Safari', async () => {
        render(<QRScanner isOpen={true} onClose={mockOnClose} onScan={mockOnScan} />);
        await assertManualFallbackVisible();
      });

      it('shows iOS Safari-specific recovery instructions', async () => {
        render(<QRScanner isOpen={true} onClose={mockOnClose} onScan={mockOnScan} />);

        await waitFor(() => {
          expect(
            screen.getByTestId('permission-instructions')
          ).toBeInTheDocument();
        });

        // All three iOS Safari step keys should be rendered
        expect(
          screen.getByText('send.permission_ios_safari_step1')
        ).toBeInTheDocument();
        expect(
          screen.getByText('send.permission_ios_safari_step2')
        ).toBeInTheDocument();
        expect(
          screen.getByText('send.permission_ios_safari_step3')
        ).toBeInTheDocument();
      });

      it('does NOT show Android or desktop instructions on iOS Safari', async () => {
        render(<QRScanner isOpen={true} onClose={mockOnClose} onScan={mockOnScan} />);

        await waitFor(() => {
          expect(screen.getByTestId('permission-instructions')).toBeInTheDocument();
        });

        expect(
          screen.queryByText('send.permission_android_chrome_step1')
        ).not.toBeInTheDocument();
        expect(
          screen.queryByText('send.permission_chrome_step1')
        ).not.toBeInTheDocument();
      });
    });

    describe('iOS PWA', () => {
      let resetUA;
      let resetStandalone;

      beforeEach(() => {
        resetUA = setUserAgent(
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
        );
        resetStandalone = setIOSStandalone(true);
        mockPermissionDenied();
      });

      afterEach(() => {
        resetUA();
        resetStandalone();
      });

      it('shows fallback + manual entry on iOS PWA', async () => {
        render(<QRScanner isOpen={true} onClose={mockOnClose} onScan={mockOnScan} />);
        await assertManualFallbackVisible();
      });

      it('shows iOS PWA-specific recovery instructions', async () => {
        render(<QRScanner isOpen={true} onClose={mockOnClose} onScan={mockOnScan} />);

        await waitFor(() => {
          expect(screen.getByTestId('permission-instructions')).toBeInTheDocument();
        });

        expect(
          screen.getByText('send.permission_ios_pwa_step1')
        ).toBeInTheDocument();
        expect(
          screen.getByText('send.permission_ios_pwa_step2')
        ).toBeInTheDocument();
        expect(
          screen.getByText('send.permission_ios_pwa_step3')
        ).toBeInTheDocument();
      });
    });

    describe('Android Chrome', () => {
      let resetUA;

      beforeEach(() => {
        resetUA = setUserAgent(
          'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.230 Mobile Safari/537.36'
        );
        window.matchMedia = vi.fn().mockReturnValue({ matches: false }); // not PWA
        mockPermissionDenied();
      });

      afterEach(() => resetUA());

      it('shows fallback + manual entry on Android Chrome', async () => {
        render(<QRScanner isOpen={true} onClose={mockOnClose} onScan={mockOnScan} />);
        await assertManualFallbackVisible();
      });

      it('shows Android Chrome-specific recovery instructions', async () => {
        render(<QRScanner isOpen={true} onClose={mockOnClose} onScan={mockOnScan} />);

        await waitFor(() => {
          expect(screen.getByTestId('permission-instructions')).toBeInTheDocument();
        });

        expect(
          screen.getByText('send.permission_android_chrome_step1')
        ).toBeInTheDocument();
        expect(
          screen.getByText('send.permission_android_chrome_step2')
        ).toBeInTheDocument();
        expect(
          screen.getByText('send.permission_android_chrome_step3')
        ).toBeInTheDocument();
      });

      it('does NOT show iOS instructions on Android Chrome', async () => {
        render(<QRScanner isOpen={true} onClose={mockOnClose} onScan={mockOnScan} />);

        await waitFor(() => {
          expect(screen.getByTestId('permission-instructions')).toBeInTheDocument();
        });

        expect(
          screen.queryByText('send.permission_ios_safari_step1')
        ).not.toBeInTheDocument();
      });
    });

    describe('Android PWA', () => {
      let resetUA;

      beforeEach(() => {
        resetUA = setUserAgent(
          'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0.6099.230 Mobile Safari/537.36'
        );
        window.matchMedia = vi.fn().mockReturnValue({ matches: true }); // standalone = true
        mockPermissionDenied();
      });

      afterEach(() => resetUA());

      it('shows fallback + manual entry on Android PWA', async () => {
        render(<QRScanner isOpen={true} onClose={mockOnClose} onScan={mockOnScan} />);
        await assertManualFallbackVisible();
      });

      it('shows Android PWA-specific recovery instructions', async () => {
        render(<QRScanner isOpen={true} onClose={mockOnClose} onScan={mockOnScan} />);

        await waitFor(() => {
          expect(screen.getByTestId('permission-instructions')).toBeInTheDocument();
        });

        expect(
          screen.getByText('send.permission_android_pwa_step1')
        ).toBeInTheDocument();
        expect(
          screen.getByText('send.permission_android_pwa_step2')
        ).toBeInTheDocument();
        expect(
          screen.getByText('send.permission_android_pwa_step3')
        ).toBeInTheDocument();
      });
    });

    describe('Desktop Chrome', () => {
      let resetUA;

      beforeEach(() => {
        resetUA = setUserAgent(
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );
        window.matchMedia = vi.fn().mockReturnValue({ matches: false });
        mockPermissionDenied();
      });

      afterEach(() => resetUA());

      it('shows fallback + manual entry on desktop Chrome', async () => {
        render(<QRScanner isOpen={true} onClose={mockOnClose} onScan={mockOnScan} />);
        await assertManualFallbackVisible();
      });

      it('shows desktop Chrome-specific recovery instructions', async () => {
        render(<QRScanner isOpen={true} onClose={mockOnClose} onScan={mockOnScan} />);

        await waitFor(() => {
          expect(screen.getByTestId('permission-instructions')).toBeInTheDocument();
        });

        expect(
          screen.getByText('send.permission_chrome_step1')
        ).toBeInTheDocument();
        expect(
          screen.getByText('send.permission_chrome_step2')
        ).toBeInTheDocument();
      });
    });

    describe('Desktop Firefox', () => {
      let resetUA;

      beforeEach(() => {
        resetUA = setUserAgent(
          'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0'
        );
        window.matchMedia = vi.fn().mockReturnValue({ matches: false });
        mockPermissionDenied();
      });

      afterEach(() => resetUA());

      it('shows fallback + manual entry on desktop Firefox', async () => {
        render(<QRScanner isOpen={true} onClose={mockOnClose} onScan={mockOnScan} />);
        await assertManualFallbackVisible();
      });

      it('shows Firefox-specific recovery instructions', async () => {
        render(<QRScanner isOpen={true} onClose={mockOnClose} onScan={mockOnScan} />);

        await waitFor(() => {
          expect(screen.getByTestId('permission-instructions')).toBeInTheDocument();
        });

        expect(
          screen.getByText('send.permission_firefox_step1')
        ).toBeInTheDocument();
        expect(
          screen.getByText('send.permission_firefox_step2')
        ).toBeInTheDocument();
      });
    });

    describe('Permission denied triggered by QrReader error event', () => {
      it('shows fallback + platform instructions on NotAllowedError from QrReader', async () => {
        // Default desktop Chrome UA from beforeEach
        render(<QRScanner isOpen={true} onClose={mockOnClose} onScan={mockOnScan} />);

        await waitFor(() => {
          expect(screen.getByTestId('qr-reader')).toBeInTheDocument();
        });

        fireEvent.click(screen.getByTestId('mock-error-permission'));

        await waitFor(() => {
          expect(screen.getByText('send.camera_access_denied')).toBeInTheDocument();
          expect(
            screen.getByPlaceholderText('send.enter_stellar_address')
          ).toBeInTheDocument();
          expect(
            screen.getByTestId('permission-instructions')
          ).toBeInTheDocument();
          expect(toast.error).toHaveBeenCalledWith('send.camera_permission_denied');
        });
      });
    });

    describe('No instructions shown when camera is absent', () => {
      it('omits recovery instructions when there is no camera hardware', async () => {
        global.navigator.mediaDevices.enumerateDevices = vi
          .fn()
          .mockResolvedValue([]);

        render(<QRScanner isOpen={true} onClose={mockOnClose} onScan={mockOnScan} />);

        await waitFor(() => {
          expect(screen.getByText('send.no_camera_detected')).toBeInTheDocument();
        });

        expect(
          screen.queryByTestId('permission-instructions')
        ).not.toBeInTheDocument();
      });
    });
  });

  // ── Camera permission denied (existing tests, kept for coverage) ──────────

  describe('Camera permission denied', () => {
    it('should show fallback UI when permission is denied', async () => {
      mockPermissionDenied();

      render(<QRScanner isOpen={true} onClose={mockOnClose} onScan={mockOnScan} />);

      await waitFor(() => {
        expect(screen.getByText('send.camera_access_denied')).toBeInTheDocument();
        expect(
          screen.getByPlaceholderText('send.enter_stellar_address')
        ).toBeInTheDocument();
      });
    });

    it('should show fallback when camera error occurs', async () => {
      render(<QRScanner isOpen={true} onClose={mockOnClose} onScan={mockOnScan} />);

      await waitFor(() => {
        expect(screen.getByTestId('qr-reader')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('mock-error-permission'));

      await waitFor(() => {
        expect(screen.getByText('send.camera_access_denied')).toBeInTheDocument();
        expect(toast.error).toHaveBeenCalledWith('send.camera_permission_denied');
      });
    });

    it('should show "Request Camera Access" button when permission denied', async () => {
      mockPermissionDenied();

      render(<QRScanner isOpen={true} onClose={mockOnClose} onScan={mockOnScan} />);

      await waitFor(() => {
        expect(screen.getByText('send.request_camera_access')).toBeInTheDocument();
      });
    });
  });

  // ── No camera device ──────────────────────────────────────────────────────

  describe('No camera device', () => {
    it('should show fallback when no camera is detected', async () => {
      global.navigator.mediaDevices.enumerateDevices = vi
        .fn()
        .mockResolvedValue([]);

      render(<QRScanner isOpen={true} onClose={mockOnClose} onScan={mockOnScan} />);

      await waitFor(() => {
        expect(screen.getByText('send.no_camera_detected')).toBeInTheDocument();
        expect(
          screen.getByPlaceholderText('send.enter_stellar_address')
        ).toBeInTheDocument();
      });
    });

    it('should not show "Request Camera Access" button when no camera exists', async () => {
      global.navigator.mediaDevices.enumerateDevices = vi
        .fn()
        .mockResolvedValue([]);

      render(<QRScanner isOpen={true} onClose={mockOnClose} onScan={mockOnScan} />);

      await waitFor(() => {
        expect(screen.getByText('send.no_camera_detected')).toBeInTheDocument();
      });

      expect(
        screen.queryByText('send.request_camera_access')
      ).not.toBeInTheDocument();
    });
  });

  // ── Manual address entry ──────────────────────────────────────────────────

  describe('Manual address entry', () => {
    beforeEach(() => {
      mockPermissionDenied();
    });

    it('should accept valid Stellar address in manual input', async () => {
      const user = userEvent.setup();
      render(<QRScanner isOpen={true} onClose={mockOnClose} onScan={mockOnScan} />);

      await waitFor(() => {
        expect(
          screen.getByPlaceholderText('send.enter_stellar_address')
        ).toBeInTheDocument();
      });

      const input = screen.getByPlaceholderText('send.enter_stellar_address');
      await user.type(input, 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567890ABCDEFGHIJKLMNOP');

      await user.click(screen.getByText('common.continue'));

      await waitFor(() => {
        expect(mockOnScan).toHaveBeenCalledWith(
          'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567890ABCDEFGHIJKLMNOP'
        );
        expect(mockOnClose).toHaveBeenCalled();
        expect(toast.success).toHaveBeenCalledWith('send.address_entered');
      });
    });

    it('should validate address starts with G', async () => {
      const user = userEvent.setup();
      render(<QRScanner isOpen={true} onClose={mockOnClose} onScan={mockOnScan} />);

      await waitFor(() => {
        expect(
          screen.getByPlaceholderText('send.enter_stellar_address')
        ).toBeInTheDocument();
      });

      const input = screen.getByPlaceholderText('send.enter_stellar_address');
      await user.type(input, 'XABCDEFGHIJKLMNOPQRSTUVWXYZ234567890ABCDEFGHIJKLMNOP');

      await user.click(screen.getByText('common.continue'));

      await waitFor(() => {
        expect(
          screen.getByText('Stellar address must start with G')
        ).toBeInTheDocument();
        expect(mockOnScan).not.toHaveBeenCalled();
      });
    });

    it('should validate address length is 56 characters', async () => {
      const user = userEvent.setup();
      render(<QRScanner isOpen={true} onClose={mockOnClose} onScan={mockOnScan} />);

      await waitFor(() => {
        expect(
          screen.getByPlaceholderText('send.enter_stellar_address')
        ).toBeInTheDocument();
      });

      const input = screen.getByPlaceholderText('send.enter_stellar_address');
      await user.type(input, 'GABCDEF');

      await user.click(screen.getByText('common.continue'));

      await waitFor(() => {
        expect(screen.getByText(/Address must be 56 characters/)).toBeInTheDocument();
        expect(mockOnScan).not.toHaveBeenCalled();
      });
    });

    it('should validate address contains only valid characters', async () => {
      const user = userEvent.setup();
      render(<QRScanner isOpen={true} onClose={mockOnClose} onScan={mockOnScan} />);

      await waitFor(() => {
        expect(
          screen.getByPlaceholderText('send.enter_stellar_address')
        ).toBeInTheDocument();
      });

      const input = screen.getByPlaceholderText('send.enter_stellar_address');
      await user.type(input, 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567890ABCDEFGHIJKLMNO@');

      await user.click(screen.getByText('common.continue'));

      await waitFor(() => {
        expect(
          screen.getByText('Address contains invalid characters')
        ).toBeInTheDocument();
        expect(mockOnScan).not.toHaveBeenCalled();
      });
    });

    it('should show character count while typing', async () => {
      const user = userEvent.setup();
      render(<QRScanner isOpen={true} onClose={mockOnClose} onScan={mockOnScan} />);

      await waitFor(() => {
        expect(
          screen.getByPlaceholderText('send.enter_stellar_address')
        ).toBeInTheDocument();
      });

      const input = screen.getByPlaceholderText('send.enter_stellar_address');
      await user.type(input, 'GABCDEFGH');

      await waitFor(() => {
        expect(screen.getByText('9/56 characters')).toBeInTheDocument();
      });
    });

    it('should clear error when user types after validation error', async () => {
      const user = userEvent.setup();
      render(<QRScanner isOpen={true} onClose={mockOnClose} onScan={mockOnScan} />);

      await waitFor(() => {
        expect(
          screen.getByPlaceholderText('send.enter_stellar_address')
        ).toBeInTheDocument();
      });

      const input = screen.getByPlaceholderText('send.enter_stellar_address');
      await user.type(input, 'SHORT');

      await user.click(screen.getByText('common.continue'));

      await waitFor(() => {
        expect(screen.getByText(/Address must be 56 characters/)).toBeInTheDocument();
      });

      await user.type(input, 'G');

      await waitFor(() => {
        expect(
          screen.queryByText(/Address must be 56 characters/)
        ).not.toBeInTheDocument();
      });
    });
  });

  // ── Request camera permission ─────────────────────────────────────────────

  describe('Request camera permission', () => {
    it('should request camera permission and switch to scanner on grant', async () => {
      const user = userEvent.setup();
      mockPermissionDenied();

      render(<QRScanner isOpen={true} onClose={mockOnClose} onScan={mockOnScan} />);

      await waitFor(() => {
        expect(screen.getByText('send.request_camera_access')).toBeInTheDocument();
      });

      await user.click(screen.getByText('send.request_camera_access'));

      await waitFor(() => {
        expect(
          global.navigator.mediaDevices.getUserMedia
        ).toHaveBeenCalledWith({ video: true });
        expect(toast.success).toHaveBeenCalledWith('send.camera_permission_granted');
      });
    });

    it('should handle permission request denial', async () => {
      const user = userEvent.setup();
      mockPermissionDenied();
      global.navigator.mediaDevices.getUserMedia = vi
        .fn()
        .mockRejectedValue({ name: 'NotAllowedError' });

      render(<QRScanner isOpen={true} onClose={mockOnClose} onScan={mockOnScan} />);

      await waitFor(() => {
        expect(screen.getByText('send.request_camera_access')).toBeInTheDocument();
      });

      await user.click(screen.getByText('send.request_camera_access'));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith(
          'send.camera_permission_denied_persistent'
        );
      });
    });
  });

  // ── Close behaviour ───────────────────────────────────────────────────────

  describe('Close behavior', () => {
    it('should reset state and call onClose when X is clicked', async () => {
      const user = userEvent.setup();
      mockPermissionDenied();

      render(<QRScanner isOpen={true} onClose={mockOnClose} onScan={mockOnScan} />);

      await waitFor(() => {
        expect(
          screen.getByPlaceholderText('send.enter_stellar_address')
        ).toBeInTheDocument();
      });

      const input = screen.getByPlaceholderText('send.enter_stellar_address');
      await user.type(input, 'GABCD');

      // The close button has aria-label set to t('common.close')
      await user.click(screen.getByRole('button', { name: 'common.close' }));

      expect(mockOnClose).toHaveBeenCalled();
    });
  });
});
