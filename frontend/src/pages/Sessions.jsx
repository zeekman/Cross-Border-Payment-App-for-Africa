import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Monitor, Trash2, LogOut, ShieldCheck } from 'lucide-react';
import api from '../utils/api';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import ConfirmModal from '../components/ConfirmModal';
import { useAuth } from '../context/AuthContext';

export default function Sessions() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { logout } = useAuth();
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState(null);
  const [confirmAll, setConfirmAll] = useState(false);
  // 'others' = revoke all other sessions (keep current); 'all' = revoke every session
  // including the current one (will sign the user out of this device too).
  const [confirmAllScope, setConfirmAllScope] = useState('others');
  const [confirmSingle, setConfirmSingle] = useState(null);
  // Device trust is now an httpOnly cookie set by the backend (issue #995) — the
  // frontend can no longer read or decode the token itself. We always offer a
  // "forget this device" action; the backend clears the cookie if one exists.
  const [revokingTrust, setRevokingTrust] = useState(false);

  const load = async () => {
    try {
      const res = await api.get('/auth/sessions');
      setSessions(res.data.sessions);
    } catch {
      toast.error(t('sessions.loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const revoke = async (id) => {
    setRevoking(id);
    try {
      await api.delete(`/auth/sessions/${id}`);
      setSessions((s) => s.filter((x) => x.id !== id));
      toast.success(t('sessions.revoked'));
    } catch {
      toast.error(t('sessions.revokeFailed'));
    } finally {
      setRevoking(null);
      setConfirmSingle(null);
    }
  };

  const revokeTrustedDevice = async () => {
    setRevokingTrust(true);
    try {
      await api.delete('/auth/device-trust');
      toast.success(t('sessions.trustRemoved'));
    } catch {
      toast.error(t('sessions.trustRemoveFailed'));
    } finally {
      setRevokingTrust(false);
    }
  };

  const revokeAll = async () => {
    setRevoking('all');
    try {
      if (confirmAllScope === 'others') {
        // keep_current=true — current session is preserved; user stays logged in here.
        await api.delete('/auth/sessions?keep_current=true');
        await load();
        toast.success(t('sessions.othersRevoked'));
      } else {
        // Revoke ALL sessions including the current one — user will be signed out.
        const res = await api.delete('/auth/sessions', { params: { include_current: true } });
        if (res.data?.current_session_revoked) await logout();
        toast.success(t('sessions.allSignedOut'));
        navigate('/login');
      }
    } catch {
      toast.error(t('sessions.revokeAllFailed'));
    } finally {
      setRevoking(null);
      setConfirmAll(false);
    }
  };

  return (
    <div className="px-4 py-6 max-w-lg mx-auto">
      <button onClick={() => navigate(-1)} className="text-gray-400 hover:text-white mb-6 flex items-center gap-1">
        <ArrowLeft size={18} /> {t('sessions.back')}
      </button>

      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-white">{t('sessions.title')}</h2>
        {sessions.length > 1 && (
          <button
            onClick={() => { setConfirmAllScope('others'); setConfirmAll(true); }}
            disabled={revoking === 'all'}
            className="text-sm text-red-400 hover:text-red-300 flex items-center gap-1 disabled:opacity-50"
          >
            <LogOut size={14} /> {t('sessions.logoutEverywhere')}
          </button>
        )}
      </div>

      {loading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div key={i} className="skeleton h-20 rounded-xl" />
          ))}
        </div>
      ) : sessions.length === 0 ? (
        <p className="text-gray-500 text-center py-8">{t('sessions.none')}</p>
      ) : (
        <div className="space-y-3">
          {sessions.map((s) => (
            <div
              key={s.id}
              className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-start justify-between gap-3"
            >
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 bg-gray-800 rounded-lg flex items-center justify-center shrink-0">
                  <Monitor size={16} className={s.is_current ? 'text-primary-400' : 'text-gray-400'} />
                </div>
                <div>
                  <p className="text-sm text-white font-medium truncate max-w-[200px]">
                    {s.device_info ? s.device_info.slice(0, 60) : t('sessions.unknownDevice')}
                    {s.is_current && (
                      <span className="ml-2 text-xs bg-primary-500/20 text-primary-400 px-1.5 py-0.5 rounded-full">
                        {t('sessions.current')}
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {s.ip_address || t('sessions.unknownIp')} · {t('sessions.lastActive', { date: new Date(s.last_active).toLocaleString(i18n.language) })}
                  </p>
                  <p className="text-xs text-gray-600">
                    {t('sessions.created', { date: new Date(s.created_at).toLocaleDateString(i18n.language) })}
                  </p>
                </div>
              </div>

              {!s.is_current && (
                <button
                  onClick={() => setConfirmSingle(s)}
                  disabled={revoking === s.id}
                  className="text-red-400 hover:text-red-300 shrink-0 disabled:opacity-50"
                  aria-label={t('sessions.revokeAria')}
                >
                  {revoking === s.id ? (
                    <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <Trash2 size={16} />
                  )}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="mt-6">
        <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">{t('sessions.trustedDevice')}</h3>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-primary-500/20 rounded-lg flex items-center justify-center shrink-0">
              <ShieldCheck size={16} className="text-primary-400" />
            </div>
            <div>
              <p className="text-sm text-white font-medium">{t('sessions.thisDevice')}</p>
              <p className="text-xs text-gray-500 mt-0.5">
                {t('sessions.trustHint')}
              </p>
            </div>
          </div>
          <button
            onClick={revokeTrustedDevice}
            disabled={revokingTrust}
            className="text-red-400 hover:text-red-300 shrink-0 disabled:opacity-50"
            aria-label={t('sessions.removeTrustAria')}
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      <ConfirmModal
        isOpen={confirmAll}
        onClose={() => setConfirmAll(false)}
        onConfirm={revokeAll}
        title={
          confirmAllScope === 'others'
            ? t('sessions.logoutOthersTitle')
            : t('sessions.logoutAllTitle')
        }
        message={
          confirmAllScope === 'others'
            ? t('sessions.logoutOthersMsg')
            : t('sessions.logoutAllMsg')
        }
        confirmLabel={confirmAllScope === 'others' ? t('sessions.logoutOthersConfirm') : t('sessions.logoutAllConfirm')}
        confirmVariant="danger"
        loading={revoking === 'all'}
      >
        {/* Secondary action: switch to the "include this device" scope */}
        {confirmAllScope === 'others' && (
          <p className="text-xs text-gray-500 mt-3 text-center">
            {t('sessions.alsoThisDevice')}{' '}
            <button
              className="text-red-400 hover:text-red-300 underline"
              onClick={() => setConfirmAllScope('all')}
              data-testid="sessions-include-this-device"
            >
              {t('sessions.includeThisDevice')}
            </button>
          </p>
        )}
      </ConfirmModal>

      <ConfirmModal
        isOpen={!!confirmSingle}
        onClose={() => setConfirmSingle(null)}
        onConfirm={() => revoke(confirmSingle.id)}
        title={t('sessions.revokeTitle')}
        message={t('sessions.revokeMsg', { device: confirmSingle ? t('sessions.revokeMsgOn', { name: confirmSingle.device_info || t('sessions.unknownDevice') }) : '' })}
        confirmLabel={t('sessions.revokeConfirm')}
        confirmVariant="danger"
        loading={revoking === confirmSingle?.id}
      />
    </div>
  );
}
