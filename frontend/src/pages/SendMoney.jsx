import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Send, ChevronDown, Users, Camera, ArrowRightLeft, Wallet } from 'lucide-react';
import api from '../utils/api';
import { useExchangeRates } from '../hooks/useExchangeRates';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import QRScanner from '../components/QRScanner';
import PINVerificationModal from '../components/PINVerificationModal';

const SLIPPAGE_OPTIONS = [0.5, 1, 2];
const DEFAULT_SLIPPAGE = 1;

export default function SendMoney() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const submitButtonRef = React.useRef(null);
  const [form, setForm] = useState({
    recipient_address: searchParams.get('to') || '',
    amount: searchParams.get('amount') || '',
    asset: searchParams.get('asset') || 'XLM',
    memo: searchParams.get('memo') || '',
    destination_asset: '',
    slippage: DEFAULT_SLIPPAGE,
    memo_type: 'text'
  });
  const [contacts, setContacts] = useState([]);
  const [showContacts, setShowContacts] = useState(false);
  const [contactSearch, setContactSearch] = useState('');
  const [selectedContactIndex, setSelectedContactIndex] = useState(-1);
  const contactSearchRef = useRef(null);
  const contactListRef = useRef(null);
  const [showScanner, setShowScanner] = useState(false);
  const [showPINVerification, setShowPINVerification] = useState(false);
  const [loading, setLoading] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [feeXLM, setFeeXLM] = useState(null);
  const [requestId] = useState(searchParams.get('request'));
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const { currencies, convertFromXLM, usingApproximateRates } = useExchangeRates();
  const [pathResult, setPathResult] = useState(null);
  const [pathLoading, setPathLoading] = useState(false);
  const [memoRequired, setMemoRequired] = useState(false);
  // 'send' = strict send (sender specifies exact amount), 'receive' = strict receive (recipient gets exact amount)
  const [sendMode, setSendMode] = useState('send');

  const isCrossAsset = form.destination_asset && form.destination_asset !== form.asset;

  // Multi-wallet state
  const [wallets, setWallets] = useState([]);
  const [selectedWalletId, setSelectedWalletId] = useState(searchParams.get('wallet_id') || null);
  const [showWalletDropdown, setShowWalletDropdown] = useState(false);

  const selectedWallet = wallets.find((w) => w.id === selectedWalletId) || wallets[0] || null;

  // Available XLM balance for the selected wallet (after minimum reserve)
  const selectedWalletXlmEntry = selectedWallet?.balances?.find((b) => b.asset === 'XLM');
  const availableXlm = selectedWalletXlmEntry?.available_balance
    ? parseFloat(selectedWalletXlmEntry.available_balance)
    : null;
  const belowMinBalance =
    form.asset === 'XLM' &&
    availableXlm !== null &&
    form.amount &&
    parseFloat(form.amount) > availableXlm;

  useEffect(() => {
    api.get('/wallet/list').then((r) => {
      setWallets(r.data.wallets || []);
      // If no wallet_id in URL, default to the user's default wallet
      if (!selectedWalletId && r.data.wallets?.length) {
        const def = r.data.wallets.find((w) => w.is_default) || r.data.wallets[0];
        setSelectedWalletId(def.id);
      }
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api.get('/wallet/contacts').then(r => setContacts(r.data.contacts || [])).catch(() => {});
  }, []);

  // Filter contacts based on search term
  const filteredContacts = useMemo(() => {
    if (!contactSearch.trim()) return contacts;
    const searchLower = contactSearch.toLowerCase();
    return contacts.filter(contact =>
      contact.name.toLowerCase().includes(searchLower) ||
      contact.wallet_address.toLowerCase().includes(searchLower)
    );
  }, [contacts, contactSearch]);

  // Reset selected index when search changes
  useEffect(() => {
    setSelectedContactIndex(-1);
  }, [contactSearch]);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (showContacts && contactSearchRef.current) {
      contactSearchRef.current.focus();
    }
  }, [showContacts]);

  // Handle keyboard navigation in contacts dropdown
  const handleContactKeyDown = (e) => {
    if (!showContacts) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedContactIndex(prev =>
          prev < filteredContacts.length - 1 ? prev + 1 : prev
        );
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedContactIndex(prev => prev > 0 ? prev - 1 : 0);
        break;
      case 'Enter':
        e.preventDefault();
        if (selectedContactIndex >= 0 && selectedContactIndex < filteredContacts.length) {
          const contact = filteredContacts[selectedContactIndex];
          setForm({
            ...form,
            recipient_address: contact.wallet_address,
            memo: contact.default_memo || form.memo,
          });
          if (contact.memo_required) setMemoRequired(true);
          setShowContacts(false);
          setContactSearch('');
        }
        break;
      case 'Escape':
        e.preventDefault();
        setShowContacts(false);
        setContactSearch('');
        break;
    }
  };

  // Scroll selected contact into view
  useEffect(() => {
    if (selectedContactIndex >= 0 && contactListRef.current) {
      const selectedElement = contactListRef.current.children[selectedContactIndex];
      if (selectedElement) {
        selectedElement.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [selectedContactIndex]);

  useEffect(() => {
    const handleResize = () => {
      if (window.visualViewport) {
        const isOpen = window.visualViewport.height < window.innerHeight * 0.75;
        setKeyboardOpen(isOpen);
        if (isOpen && submitButtonRef.current) {
          setTimeout(() => submitButtonRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100);
        }
      }
    };
    window.visualViewport?.addEventListener('resize', handleResize);
    return () => window.visualViewport?.removeEventListener('resize', handleResize);
  }, []);
  // Debounced path finding
  const findPath = useCallback(async () => {
    if (!isCrossAsset || !form.amount || !form.recipient_address) {
      setPathResult(null);
      return;
    }
    setPathLoading(true);
    try {
      if (sendMode === 'receive') {
        // Strict receive: user specifies destination amount, we find source amount
        const res = await api.post('/payments/find-receive-path', {
          source_asset: form.asset,
          destination_asset: form.destination_asset,
          destination_amount: parseFloat(form.amount),
          recipient_address: form.recipient_address,
        });
        setPathResult(res.data);
      } else {
        // Strict send: user specifies source amount, we find destination amount
        const res = await api.post('/payments/find-path', {
          source_asset: form.asset,
          source_amount: parseFloat(form.amount),
          destination_asset: form.destination_asset,
          recipient_address: form.recipient_address,
        });
        setPathResult(res.data);
      }
    } catch {
      setPathResult(null);
    } finally {
      setPathLoading(false);
    }
  }, [form.amount, form.asset, form.destination_asset, form.recipient_address, isCrossAsset, sendMode]);

  useEffect(() => {
    const timer = setTimeout(findPath, 600);
    return () => clearTimeout(timer);
  }, [findPath]);

  const checkMemoRequired = useCallback(async (address) => {
    if (!address || address.length < 56) { setMemoRequired(false); return; }
    try {
      const res = await api.get('/payments/memo-required', { params: { address } });
      setMemoRequired(res.data.memo_required === true);
    } catch {
      setMemoRequired(false);
    }
  }, []);

  const estimatedValue = form.amount && form.asset === 'XLM'
    ? `≈ ${convertFromXLM(form.amount, 'USD')} USD`
    : '';

  // Minimum destination amount after slippage
  const destMin = pathResult
    ? (parseFloat(pathResult.destinationAmount) * (1 - form.slippage / 100)).toFixed(7)
    : null;
  const memoTrimmed = form.memo.trim();
  const memoMaxLen =
    form.memo_type === 'id' ? 20 : form.memo_type === 'text' ? 28 : 64;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!confirmed) {
      // Fetch fresh fee estimate at confirmation time
      try {
        const r = await api.get('/payments/estimate-fee');
        setFeeXLM(r.data.fee_xlm);
      } catch {
        setFeeXLM(null);
      }
      setConfirmed(true);
      return;
    }
    // Show PIN verification modal instead of directly submitting
    if (!confirmed) { setConfirmed(true); return; }
    setShowPINVerification(true);
  };

  const handlePINVerified = async () => {
    setLoading(true);
    try {
      let res;
      if (isCrossAsset && pathResult) {
        if (sendMode === 'receive') {
          // Strict receive: recipient gets exact destination_amount
          const sourceMax = (parseFloat(pathResult.sourceAmount) * (1 + form.slippage / 100)).toFixed(7);
          res = await api.post('/payments/send-strict-receive', {
            recipient_address: form.recipient_address,
            source_asset: form.asset,
            source_max_amount: parseFloat(sourceMax),
            destination_asset: form.destination_asset,
            destination_amount: parseFloat(form.amount),
            path: pathResult.path,
            memo: form.memo || undefined,
            wallet_id: selectedWallet?.id || undefined,
          });
        } else {
          res = await api.post('/payments/send-path', {
          recipient_address: form.recipient_address,
          source_asset: form.asset,
          source_amount: parseFloat(form.amount),
          destination_asset: form.destination_asset,
          destination_min_amount: parseFloat(destMin),
          path: pathResult.path,
          memo: form.memo || undefined,
          wallet_id: selectedWallet?.id || undefined,
        });
        }
        toast.success(t('send.success'));
        if (requestId) {
          await api.post(`/payment-requests/${requestId}/claim`, {
            txHash: res.data.transaction.tx_hash
          }).catch(() => {});
        }
        navigate('/dashboard');
      } else {
        const payload = {
          recipient_address: form.recipient_address,
          amount: parseFloat(form.amount),
          asset: form.asset,
        };
        if (form.memo.trim()) {
          payload.memo = form.memo.trim();
          payload.memo_type = form.memo_type;
        }
        const res = await api.post('/payments/send', payload);

        if (requestId) {
          await api.post(`/payment-requests/${requestId}/claim`, {
            txHash: res.data.transaction.tx_hash
          }).catch(() => {});
        }

        toast.success(t('send.success'));
        navigate('/dashboard');
      }
        const m = form.memo.trim();
        let recipientAddress = form.recipient_address;

        // Resolve federation address if needed
        if (recipientAddress.includes('*')) {
          const fedRes = await api.get('/payments/resolve-federation', { params: { address: recipientAddress } });
          recipientAddress = fedRes.data.public_key;
        }

        const payload = {
          recipient_address: recipientAddress,
          amount: parseFloat(form.amount),
          asset: form.asset,
          wallet_id: selectedWallet?.id || undefined,
        };
        if (m) {
          payload.memo = m;
          payload.memo_type = form.memo_type;
        }
        res = await api.post('/payments/send', payload);
      }

      // Offline queue — the api interceptor returns { queued: true }
      if (res.data?.queued) {
        toast.success('You\'re offline. Payment queued — it will send automatically when you reconnect.', { duration: 5000 });
        navigate('/dashboard');
        return;
      }

      // Mark payment request as claimed if applicable
      if (requestId) {
        await api.post(`/payment-requests/${requestId}/claim`, {
          txHash: res.data?.transaction?.tx_hash,
        }).catch(() => {});
      }

      toast.success(t('send.success'));
      navigate('/dashboard');
    } catch (err) {
      toast.error(err.response?.data?.error || t('send.error'));
      setConfirmed(false);
      setShowPINVerification(false);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="px-4 py-6 max-w-lg mx-auto pb-safe" style={{ paddingBottom: keyboardOpen ? 'max(1.5rem, env(safe-area-inset-bottom))' : '1.5rem' }}>
      <button onClick={() => navigate(-1)} className="text-gray-400 hover:text-white mb-6 flex items-center gap-1">
        <ArrowLeft size={18} /> {t('common.back')}
      </button>

      <h2 className="text-2xl font-bold text-white mb-6">{t('send.title')}</h2>

      <form onSubmit={handleSubmit} className="space-y-4 overflow-y-auto" style={{ maxHeight: keyboardOpen ? 'calc(100vh - 200px)' : 'auto' }}>
        {/* Wallet selector */}
        {wallets.length > 1 && (
          <div>
            <label className="text-sm text-gray-400 mb-1 block">Send from</label>
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowWalletDropdown((v) => !v)}
                className="w-full flex items-center justify-between bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white hover:border-primary-500 transition-colors"
                aria-haspopup="listbox"
                aria-expanded={showWalletDropdown}
              >
                <div className="flex items-center gap-2">
                  <Wallet size={15} className="text-primary-400" />
                  <span className="text-sm">{selectedWallet?.label || 'Select wallet'}</span>
                  {selectedWallet && (
                    <span className="text-xs text-gray-500 font-mono">
                      ({selectedWallet.balances?.find((b) => b.asset === 'XLM')?.balance || '0'} XLM)
                    </span>
                  )}
                </div>
                <ChevronDown
                  size={14}
                  className={`text-gray-400 transition-transform ${showWalletDropdown ? 'rotate-180' : ''}`}
                />
              </button>

              {showWalletDropdown && (
                <div
                  className="absolute z-20 mt-1 w-full bg-gray-800 border border-gray-700 rounded-xl shadow-xl overflow-hidden"
                  role="listbox"
                >
                  {wallets.map((w) => {
                    const xlm = w.balances?.find((b) => b.asset === 'XLM')?.balance || '0';
                    return (
                      <button
                        key={w.id}
                        type="button"
                        role="option"
                        aria-selected={w.id === selectedWalletId}
                        onClick={() => {
                          setSelectedWalletId(w.id);
                          setShowWalletDropdown(false);
                        }}
                        className={`w-full flex items-center justify-between px-4 py-3 text-left transition-colors ${
                          w.id === selectedWalletId
                            ? 'bg-primary-500/20 text-primary-400'
                            : 'hover:bg-gray-700 text-white'
                        }`}
                      >
                        <div>
                          <p className="text-sm font-medium">{w.label}</p>
                          <p className="text-xs text-gray-500 font-mono">{w.public_key.slice(0, 16)}…</p>
                        </div>
                        <p className="text-sm font-semibold">{parseFloat(xlm).toLocaleString()} XLM</p>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Recipient */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-sm text-gray-400">{t('send.recipient_label')}</label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowScanner(true)}
                className="text-primary-500 hover:text-primary-400 p-1.5 rounded-lg hover:bg-primary-500/10 transition-colors"
                title={t('send.scan_qr')}
                aria-label={t('send.scan_qr')}
              >
                <Camera size={16} />
              </button>
              {contacts.length > 0 && (
                <button type="button" onClick={() => setShowContacts(!showContacts)}
                  className="text-primary-500 text-xs flex items-center gap-1">
                  <Users size={12} /> {t('send.contacts')}
                </button>
              )}
            </div>
          </div>
          <input
            type="text"
            required
            placeholder={t('send.recipient_placeholder') || 'Wallet address or username*domain'}
            value={form.recipient_address}
            onChange={e => { setForm({ ...form, recipient_address: e.target.value }); setMemoRequired(false); }}
            onBlur={e => checkMemoRequired(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors font-mono text-sm"
          />
          {showContacts && contacts.length > 0 && (
            <div
              className="mt-1 bg-gray-800 border border-gray-700 rounded-xl overflow-hidden"
              onKeyDown={handleContactKeyDown}
            >
              {/* Search input */}
              <div className="p-2 border-b border-gray-700">
                <input
                  ref={contactSearchRef}
                  type="text"
                  placeholder="Search contacts..."
                  value={contactSearch}
                  onChange={(e) => setContactSearch(e.target.value)}
                  className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-400 focus:outline-none focus:border-primary-500"
                  aria-label="Search contacts"
                />
              </div>
              
              {/* Contact list */}
              <div ref={contactListRef} className="max-h-60 overflow-y-auto">
                {filteredContacts.length > 0 ? (
                  filteredContacts.map((c, index) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        setForm({
                          ...form,
                          recipient_address: c.wallet_address,
                          memo: c.default_memo || form.memo,
                        });
                        if (c.memo_required) setMemoRequired(true);
                        setShowContacts(false);
                        setContactSearch('');
                      }}
                      className={`w-full px-4 py-2.5 text-left transition-colors ${
                        index === selectedContactIndex
                          ? 'bg-primary-500/20 text-primary-400'
                          : 'hover:bg-gray-700'
                      }`}
                    >
                      <p className="text-sm text-white">{c.name}</p>
                      <p className="text-xs text-gray-500 font-mono">{c.wallet_address.slice(0, 20)}...</p>
                    </button>
                  ))
                ) : (
                  <div className="px-4 py-6 text-center text-gray-400">
                    <p className="text-sm">No contacts match</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {memoRequired && !form.memo.trim() && (
          <div className="bg-yellow-500/10 border border-yellow-500/40 rounded-xl px-4 py-3 text-yellow-400 text-sm">
            ⚠️ This address requires a memo. Payments without a memo may be lost.
          </div>
        )}

        {/* Amount + Source Asset */}
        <div>
          <label className="text-sm text-gray-400 mb-1 block">
            {isCrossAsset && sendMode === 'receive' ? `Recipient receives (${form.destination_asset || form.asset})` : t('send.amount')}
          </label>
          <div className="flex gap-2">
            <input
              type="number"
              required
              min="0.0000001"
              step="any"
              placeholder="0.00"
              value={form.amount}
              onChange={e => setForm({ ...form, amount: e.target.value })}
              className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors"
            />
            <div className="relative">
              <select
                value={form.asset}
                onChange={e => setForm({ ...form, asset: e.target.value })}
                className="appearance-none bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-primary-500 pr-8 transition-colors"
              >
                {currencies.map(c => (
                  <option key={c.code} value={c.code}>{c.flag} {c.code}</option>
                ))}
              </select>
              <ChevronDown size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            </div>
          </div>
          {estimatedValue && (
            <div className="mt-1 space-y-1">
              <p className="text-xs text-gray-500">{estimatedValue}</p>
              {usingApproximateRates && (
                <p className="text-xs text-amber-500/90">{t('common.rates_disclaimer')}</p>
              )}
            </div>
          )}
          {availableXlm !== null && form.asset === 'XLM' && (
            <p className="text-xs text-gray-500 mt-1">
              Available to send: {availableXlm.toLocaleString()} XLM
            </p>
          )}
          {belowMinBalance && (
            <div className="mt-2 bg-red-500/10 border border-red-500/40 rounded-xl px-4 py-3 text-red-400 text-sm">
              ⚠️ This amount exceeds your available balance ({availableXlm.toLocaleString()} XLM). Sending it would drop your account below the Stellar minimum reserve.
            </div>
          )}
        </div>

        {/* Destination Asset (cross-asset toggle) */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-sm text-gray-400 flex items-center gap-1">
              <ArrowRightLeft size={13} /> Recipient receives (optional)
            </label>
            <div className="flex items-center gap-2">
              {form.destination_asset && (
                <div className="flex items-center gap-1 bg-gray-800 rounded-lg p-0.5">
                  <button
                    type="button"
                    onClick={() => { setSendMode('send'); setPathResult(null); }}
                    className={`text-xs px-2 py-1 rounded-md transition-colors ${sendMode === 'send' ? 'bg-primary-500 text-white' : 'text-gray-400 hover:text-white'}`}
                  >
                    I send exact
                  </button>
                  <button
                    type="button"
                    onClick={() => { setSendMode('receive'); setPathResult(null); }}
                    className={`text-xs px-2 py-1 rounded-md transition-colors ${sendMode === 'receive' ? 'bg-primary-500 text-white' : 'text-gray-400 hover:text-white'}`}
                  >
                    They receive exact
                  </button>
                </div>
              )}
              {form.destination_asset && (
                <button type="button" onClick={() => { setForm({ ...form, destination_asset: '' }); setPathResult(null); setSendMode('send'); }}
                  className="text-xs text-gray-500 hover:text-white transition-colors">
                  Clear
                </button>
              )}
            </div>
          </div>
          <div className="relative">
            <select
              value={form.destination_asset}
              onChange={e => setForm({ ...form, destination_asset: e.target.value })}
              className="appearance-none w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-primary-500 pr-8 transition-colors"
            >
              <option value="">Same as sent ({form.asset})</option>
              {currencies.filter(c => c.code !== form.asset).map(c => (
                <option key={c.code} value={c.code}>{c.flag} {c.code}</option>
              ))}
            </select>
            <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          </div>

          {/* Path result / loading */}
          {isCrossAsset && (
            <div className="mt-2 px-3 py-2 bg-gray-800 border border-gray-700 rounded-xl text-sm">
              {pathLoading && <p className="text-gray-400 animate-pulse">Finding best rate...</p>}
              {!pathLoading && pathResult && sendMode === 'send' && (
                <div className="space-y-1">
                  <p className="text-green-400">
                    Recipient receives ≈ <span className="font-semibold">{pathResult.destinationAmount} {form.destination_asset}</span>
                  </p>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-gray-500">Slippage tolerance:</span>
                    {SLIPPAGE_OPTIONS.map(s => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setForm({ ...form, slippage: s })}
                        className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                          form.slippage === s
                            ? 'border-primary-500 text-primary-400'
                            : 'border-gray-600 text-gray-400 hover:border-gray-400'
                        }`}
                      >
                        {s}%
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-gray-500">Min received: {destMin} {form.destination_asset}</p>
                </div>
              )}
              {!pathLoading && pathResult && sendMode === 'receive' && (
                <div className="space-y-1">
                  <p className="text-green-400">
                    Recipient receives exactly <span className="font-semibold">{form.amount} {form.destination_asset}</span>
                  </p>
                  <p className="text-yellow-300 text-xs">
                    You pay approximately <span className="font-semibold">{pathResult.sourceAmount} {form.asset}</span>
                  </p>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-gray-500">Max slippage:</span>
                    {SLIPPAGE_OPTIONS.map(s => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setForm({ ...form, slippage: s })}
                        className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                          form.slippage === s
                            ? 'border-primary-500 text-primary-400'
                            : 'border-gray-600 text-gray-400 hover:border-gray-400'
                        }`}
                      >
                        {s}%
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-gray-500">
                    Max you pay: {(parseFloat(pathResult.sourceAmount) * (1 + form.slippage / 100)).toFixed(7)} {form.asset}
                  </p>
                </div>
              )}
              {!pathLoading && !pathResult && form.amount && form.recipient_address && (
                <p className="text-yellow-500 text-xs">No conversion path found for these assets</p>
              )}
            </div>
          )}
        </div>

        {/* Memo */}
        <div>
          <label className="text-sm text-gray-400 mb-1 block">{t('send.memo')}</label>
          <input
            type="text"
            maxLength={memoMaxLen}
            placeholder={t('send.memo_placeholder')}
            value={form.memo}
            onChange={e => setForm({ ...form, memo: e.target.value })}
            className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors font-mono text-sm"
          />
          {memoTrimmed ? (
            <div className="mt-2">
              <label className="text-sm text-gray-400 mb-1 block" htmlFor="memo-type">
                {t('send.memo_type_label')}
              </label>
              <select
                id="memo-type"
                value={form.memo_type}
                onChange={e => setForm({ ...form, memo_type: e.target.value })}
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-primary-500 transition-colors"
              >
                <option value="text">{t('send.memo_type_text')}</option>
                <option value="id">{t('send.memo_type_id')}</option>
                <option value="hash">{t('send.memo_type_hash')}</option>
                <option value="return">{t('send.memo_type_return')}</option>
              </select>
              <p className="text-xs text-gray-500 mt-1">{t(`send.memo_hint_${form.memo_type}`)}</p>
            </div>
          ) : null}
        </div>

        {/* Private Note */}
        <div>
          <label className="text-sm text-gray-400 mb-1 block">Private note <span className="text-gray-600">(only visible to you)</span></label>
          <input
            type="text"
            maxLength={500}
            placeholder="Invoice #, project code, personal reminder…"
            value={form.private_note}
            onChange={e => setForm({ ...form, private_note: e.target.value })}
            className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-primary-500 transition-colors"
          />
        </div>

        {/* Confirmation preview */}
        {confirmed && (
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 space-y-2">
            <p className="text-yellow-400 font-semibold text-sm">{t('send.confirm_title')}</p>
            <div className="text-sm text-gray-300 space-y-1">
              <p>{t('send.confirm_to')} <span className="font-mono text-xs">{form.recipient_address.slice(0, 20)}...</span></p>
              <p>{t('send.confirm_amount')} <span className="text-white font-semibold">{form.amount} {form.asset}</span></p>
              {feeXLM && (
                <>
                  <p>{t('send.confirm_fee', 'Network fee:')} <span className="text-white">{feeXLM} XLM</span></p>
                  {form.asset === 'XLM' && (
                    <p className="text-yellow-300 font-semibold">
                      {t('send.confirm_total', 'Total:')} {(parseFloat(form.amount) + parseFloat(feeXLM)).toFixed(7)} XLM
                    </p>
                  )}
                </>
              )}
              {isCrossAsset && pathResult && sendMode === 'send' && (
                <p>Recipient receives ≈ <span className="text-white font-semibold">{pathResult.destinationAmount} {form.destination_asset}</span> (min {destMin})</p>
              )}
              {isCrossAsset && pathResult && sendMode === 'receive' && (
                <>
                  <p>Recipient receives exactly <span className="text-white font-semibold">{form.amount} {form.destination_asset}</span></p>
                  <p>You pay approximately <span className="text-white font-semibold">{pathResult.sourceAmount} {form.asset}</span></p>
                </>
              )}
              {form.memo && <p>{t('send.confirm_memo')} {form.memo}</p>}
              {form.memo.trim() ? (
                <>
                  <p>{t('send.confirm_memo')} {form.memo.trim()}</p>
                  <p className="text-gray-400 text-xs">
                    {t('send.confirm_memo_type')} {t(`send.memo_type_${form.memo_type}`)}
                  </p>
                </>
              ) : null}
            </div>
          </div>
        )}

        <button
          ref={submitButtonRef}
          type="submit"
          disabled={loading || (isCrossAsset && !pathResult) || (memoRequired && !form.memo.trim())}
          className={`w-full font-semibold py-3.5 rounded-xl flex items-center justify-center gap-2 transition-colors ${
            confirmed
              ? 'bg-yellow-500 hover:bg-yellow-600 text-black'
              : 'bg-primary-500 hover:bg-primary-600 text-white'
          } disabled:opacity-50`}
        >
          {loading ? (
            <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" role="status" aria-label="Loading" />
          ) : (
            <><Send size={18} /> {confirmed ? t('send.confirm_send') : t('send.review')}</>
          )}
        </button>

        {confirmed && (
          <button type="button" onClick={() => { setConfirmed(false); setFeeXLM(null); }}
            className="w-full text-gray-400 hover:text-white text-sm py-2 transition-colors">
            {t('common.cancel')}
          </button>
        )}
      </form>

      <QRScanner
        isOpen={showScanner}
        onClose={() => setShowScanner(false)}
        onScan={(address) => setForm({ ...form, recipient_address: address })}
      />

      <PINVerificationModal
        isOpen={showPINVerification}
        onClose={() => setShowPINVerification(false)}
        onSuccess={handlePINVerified}
        amount={`${form.amount} ${form.asset}`}
        recipient={form.recipient_address}
      />
    </div>
  );
}
