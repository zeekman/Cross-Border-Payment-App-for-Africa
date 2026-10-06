import React, { useState, useEffect } from 'react';
import { QrReader } from 'react-qr-reader';
import { X, AlertCircle, Camera, Smartphone } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

/**
 * Detect the current browser/platform context.
 *
 * Returns one of:
 *   'ios_safari'      – iPhone/iPad running Safari (WKWebView) or iOS PWA
 *   'ios_pwa'         – iOS home-screen PWA (navigator.standalone)
 *   'android_chrome'  – Android device running Chrome
 *   'android_pwa'     – Android PWA installed via Chrome
 *   'desktop_chrome'  – Chrome/Edge on macOS or Windows
 *   'desktop_firefox' – Firefox on desktop
 *   'unknown'         – anything else
 */
export function detectPlatform() {
  if (typeof navigator === 'undefined') return 'unknown';

  const ua = navigator.userAgent || '';
  const isIOS = /iphone|ipad|ipod/i.test(ua);
  const isAndroid = /android/i.test(ua);
  const isChrome = /chrome|crios/i.test(ua) && !/edg/i.test(ua);
  const isFirefox = /firefox|fxios/i.test(ua);
  // navigator.standalone is true in iOS home-screen PWAs
  const isIOSPWA = isIOS && navigator.standalone === true;
  // In Android Chrome the display-mode media query covers installed PWAs
  const isAndroidPWA =
    isAndroid &&
    typeof window !== 'undefined' &&
    window.matchMedia('(display-mode: standalone)').matches;

  if (isIOSPWA) return 'ios_pwa';
  if (isIOS) return 'ios_safari';
  if (isAndroidPWA) return 'android_pwa';
  if (isAndroid && isChrome) return 'android_chrome';
  if (isFirefox) return 'desktop_firefox';
  return 'desktop_chrome'; // covers Chrome, Edge, Brave, etc. on desktop
}

export default function QRScanner({ isOpen, onClose, onScan }) {
  const { t } = useTranslation();
  const [error, setError] = useState(null);
  const [cameraPermission, setCameraPermission] = useState('prompt'); // 'granted', 'denied', 'prompt'
  const [hasCamera, setHasCamera] = useState(true);
  const [showFallback, setShowFallback] = useState(false);
  const [manualAddress, setManualAddress] = useState('');
  const [manualError, setManualError] = useState('');

  const platform = detectPlatform();

  // Check camera permission and availability when modal opens
  useEffect(() => {
    if (!isOpen) return;

    const checkCameraAccess = async () => {
      try {
        // Check if camera devices exist
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(device => device.kind === 'videoinput');

        if (videoDevices.length === 0) {
          setHasCamera(false);
          setShowFallback(true);
          return;
        }

        // Check camera permission status
        if (navigator.permissions && navigator.permissions.query) {
          const permissionStatus = await navigator.permissions.query({ name: 'camera' });
          setCameraPermission(permissionStatus.state);

          if (permissionStatus.state === 'denied') {
            setShowFallback(true);
          }

          // Listen for permission changes
          permissionStatus.onchange = () => {
            setCameraPermission(permissionStatus.state);
            if (permissionStatus.state === 'granted') {
              setShowFallback(false);
              setError(null);
            } else if (permissionStatus.state === 'denied') {
              setShowFallback(true);
            }
          };
        }
      } catch (err) {
        console.error('Error checking camera access:', err);
        // If we can't check, let the QrReader handle it
      }
    };

    checkCameraAccess();
  }, [isOpen]);

  const handleScan = (result) => {
    if (result?.text) {
      // Validate it looks like a Stellar address (starts with 'G' and is 56 chars)
      const address = result.text.trim();
      if (address.startsWith('G') && address.length === 56) {
        toast.success(t('send.qr_scanned'));
        onScan(address);
        onClose();
      } else {
        setError(t('send.qr_invalid'));
        toast.error(t('send.qr_invalid'));
      }
    }
  };

  const handleError = (err) => {
    console.error('QR Scanner error:', err);
    if (err.name === 'NotAllowedError') {
      setCameraPermission('denied');
      setShowFallback(true);
      toast.error(t('send.camera_permission_denied'));
    } else if (err.name === 'NotFoundError') {
      setHasCamera(false);
      setShowFallback(true);
      toast.error(t('send.camera_not_found'));
    } else {
      setError(t('send.camera_error'));
      toast.error(t('send.camera_error'));
    }
  };

  const validateStellarAddress = (address) => {
    const trimmed = address.trim();
    if (!trimmed) {
      return 'Address is required';
    }
    if (!trimmed.startsWith('G')) {
      return 'Stellar address must start with G';
    }
    if (trimmed.length !== 56) {
      return `Address must be 56 characters (currently ${trimmed.length})`;
    }
    // Basic alphanumeric check
    if (!/^[A-Z0-9]+$/.test(trimmed)) {
      return 'Address contains invalid characters';
    }
    return null;
  };

  const handleManualSubmit = (e) => {
    e.preventDefault();
    const validationError = validateStellarAddress(manualAddress);

    if (validationError) {
      setManualError(validationError);
      return;
    }

    toast.success(t('send.address_entered'));
    onScan(manualAddress.trim());
    handleClose();
  };

  const handleRequestPermission = async () => {
    try {
      // Attempt to request camera access
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      // Stop the stream immediately - we just wanted to trigger permission
      stream.getTracks().forEach(track => track.stop());

      setCameraPermission('granted');
      setShowFallback(false);
      setError(null);
      toast.success(t('send.camera_permission_granted'));
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        setCameraPermission('denied');
        toast.error(t('send.camera_permission_denied_persistent'));
      } else if (err.name === 'NotFoundError') {
        setHasCamera(false);
        toast.error(t('send.camera_not_found'));
      } else {
        toast.error(t('send.camera_error'));
      }
    }
  };

  const handleClose = () => {
    setManualAddress('');
    setManualError('');
    setError(null);
    onClose();
  };

  if (!isOpen) return null;

  const getFallbackMessage = () => {
    if (!hasCamera) {
      return t('send.no_camera_detected');
    }
    if (cameraPermission === 'denied') {
      return t('send.camera_access_denied');
    }
    return t('send.camera_access_denied');
  };

  /**
   * Returns a list of step strings for fixing camera permission on the
   * detected platform. Each string is a translation key.
   */
  const getPermissionInstructions = () => {
    if (!hasCamera) return [];

    switch (platform) {
      case 'ios_safari':
        return [
          t('send.permission_ios_safari_step1'),
          t('send.permission_ios_safari_step2'),
          t('send.permission_ios_safari_step3'),
        ];
      case 'ios_pwa':
        return [
          t('send.permission_ios_pwa_step1'),
          t('send.permission_ios_pwa_step2'),
          t('send.permission_ios_pwa_step3'),
        ];
      case 'android_chrome':
        return [
          t('send.permission_android_chrome_step1'),
          t('send.permission_android_chrome_step2'),
          t('send.permission_android_chrome_step3'),
        ];
      case 'android_pwa':
        return [
          t('send.permission_android_pwa_step1'),
          t('send.permission_android_pwa_step2'),
          t('send.permission_android_pwa_step3'),
        ];
      case 'desktop_firefox':
        return [
          t('send.permission_firefox_step1'),
          t('send.permission_firefox_step2'),
        ];
      case 'desktop_chrome':
      default:
        return [
          t('send.permission_chrome_step1'),
          t('send.permission_chrome_step2'),
        ];
    }
  };

  const permissionInstructions = cameraPermission === 'denied' ? getPermissionInstructions() : [];

  return (
    <div className="fixed inset-0 bg-black bg-opacity-75 z-50 flex items-center justify-center p-4">
      <div className="bg-gray-900 rounded-2xl w-full max-w-md overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between bg-gray-800 px-4 py-4">
          <h3 className="text-lg font-semibold text-white">
            {showFallback ? t('send.enter_address') : t('send.scan_qr')}
          </h3>
          <button
            onClick={handleClose}
            aria-label={t('common.close')}
            className="text-gray-400 hover:text-white transition-colors"
          >
            <X size={24} />
          </button>
        </div>

        {/* Scanner, Fallback, or Error */}
        <div className="bg-black relative overflow-hidden">
          {showFallback ? (
            <div className="flex flex-col items-center bg-gray-900 p-5">
              {/* Permission denied / no camera icon + headline */}
              <Camera size={40} className="text-gray-500 mb-3 flex-shrink-0" />
              <p className="text-yellow-400 text-center text-sm font-semibold mb-2">
                {getFallbackMessage()}
              </p>

              {/* Platform-specific recovery steps — shown only on permission denied */}
              {permissionInstructions.length > 0 && (
                <div
                  data-testid="permission-instructions"
                  className="w-full bg-gray-800 rounded-lg px-4 py-3 mb-4"
                  aria-label={t('send.permission_instructions_label')}
                >
                  <p className="text-gray-300 text-xs font-semibold mb-2 flex items-center gap-1">
                    <Smartphone size={13} />
                    {t('send.permission_fix_title')}
                  </p>
                  <ol className="space-y-1 list-decimal list-inside">
                    {permissionInstructions.map((step, i) => (
                      <li key={i} className="text-gray-400 text-xs leading-relaxed">
                        {step}
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              {/* ── Manual address entry (always prominent) ── */}
              <p className="text-gray-400 text-center text-xs mb-3">
                {t('send.manual_entry_prompt')}
              </p>

              <form onSubmit={handleManualSubmit} className="w-full space-y-3">
                <div>
                  <input
                    type="text"
                    value={manualAddress}
                    onChange={(e) => {
                      setManualAddress(e.target.value);
                      setManualError('');
                    }}
                    placeholder={t('send.enter_stellar_address')}
                    className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-primary-500 text-sm font-mono"
                    maxLength={56}
                    autoComplete="off"
                    spellCheck={false}
                    aria-label={t('send.enter_stellar_address')}
                  />
                  {manualError && (
                    <p className="text-red-400 text-xs mt-1">{manualError}</p>
                  )}
                  {manualAddress && !manualError && (
                    <p className="text-gray-500 text-xs mt-1">
                      {manualAddress.length}/56 characters
                    </p>
                  )}
                </div>

                <button
                  type="submit"
                  className="w-full bg-primary-600 hover:bg-primary-700 text-white font-medium py-3 rounded-lg transition-colors"
                >
                  {t('common.continue')}
                </button>

                {/* Request Camera Access button — only useful on platforms where
                    re-prompting is possible (Android Chrome, desktop) */}
                {cameraPermission === 'denied' && hasCamera && (
                  <button
                    type="button"
                    onClick={handleRequestPermission}
                    className="w-full bg-gray-700 hover:bg-gray-600 text-white font-medium py-3 rounded-lg transition-colors flex items-center justify-center gap-2"
                  >
                    <Camera size={18} />
                    {t('send.request_camera_access')}
                  </button>
                )}
              </form>
            </div>
          ) : error ? (
            <div className="aspect-square flex flex-col items-center justify-center bg-black/80 p-4">
              <AlertCircle size={48} className="text-red-500 mb-4" />
              <p className="text-red-400 text-center text-sm">{error}</p>
              <button
                onClick={() => setError(null)}
                className="mt-4 text-primary-500 hover:text-primary-400 text-sm font-medium"
              >
                {t('common.retry')}
              </button>
            </div>
          ) : (
            <div className="aspect-square">
              <QrReader
                onResult={handleScan}
                onError={handleError}
                constraints={{ facingMode: 'environment' }}
                videoStyle={{ width: '100%', height: '100%' }}
                scanDelay={300}
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="bg-gray-800 px-4 py-3">
          <p className="text-gray-400 text-xs text-center">
            {showFallback ? t('send.manual_entry_hint') : t('send.qr_hint')}
          </p>
        </div>
      </div>
    </div>
  );
}
