import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Monitor, Trash2, LogOut } from 'lucide-react';
import api from '../utils/api';
import toast from 'react-hot-toast';

export default function Sessions() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState(null);

  const load = async () => {
    try {
      const res = await api.get('/auth/sessions');
      setSessions(res.data.sessions);
    } catch {
      toast.error('Failed to load sessions');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const revoke = async (id) => {
    setRevoking(id);
    try {
      await api.delete(`/auth/sessions/${id}`);
      setSessions((s) => s.filter((x) => x.id !== id));
      toast.success('Session revoked');
    } catch {
      toast.error('Failed to revoke session');
    } finally {
      setRevoking(null);
    }
  };

  const revokeAll = async () => {
    setRevoking('all');
    try {
      await api.delete('/auth/sessions?keep_current=true');
      await load();
      toast.success('All other sessions revoked');
    } catch {
      toast.error('Failed to revoke sessions');
    } finally {
      setRevoking(null);
    }
  };

  return (
    <div className="px-4 py-6 max-w-lg mx-auto">
      <button onClick={() => navigate(-1)} className="text-gray-400 hover:text-white mb-6 flex items-center gap-1">
        <ArrowLeft size={18} /> Back
      </button>

      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-white">Active Sessions</h2>
        {sessions.length > 1 && (
          <button
            onClick={revokeAll}
            disabled={revoking === 'all'}
            className="text-sm text-red-400 hover:text-red-300 flex items-center gap-1 disabled:opacity-50"
          >
            <LogOut size={14} /> Logout everywhere
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
        <p className="text-gray-500 text-center py-8">No active sessions</p>
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
                    {s.device_info ? s.device_info.slice(0, 60) : 'Unknown device'}
                    {s.is_current && (
                      <span className="ml-2 text-xs bg-primary-500/20 text-primary-400 px-1.5 py-0.5 rounded-full">
                        Current
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {s.ip_address || 'Unknown IP'} · Last active{' '}
                    {new Date(s.last_active).toLocaleString()}
                  </p>
                  <p className="text-xs text-gray-600">
                    Created {new Date(s.created_at).toLocaleDateString()}
                  </p>
                </div>
              </div>

              {!s.is_current && (
                <button
                  onClick={() => revoke(s.id)}
                  disabled={revoking === s.id}
                  className="text-red-400 hover:text-red-300 shrink-0 disabled:opacity-50"
                  aria-label="Revoke session"
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
    </div>
  );
}
