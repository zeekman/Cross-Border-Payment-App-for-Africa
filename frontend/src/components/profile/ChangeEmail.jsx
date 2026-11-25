import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { Mail } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import api from '../../utils/api';

export default function ChangeEmail() {
  const { user } = useAuth();

  // Change email state (issue #301)
  const [showChangeEmail, setShowChangeEmail] = useState(false);
  const [changeEmailForm, setChangeEmailForm] = useState({ new_email: '', password: '' });
  const [changeEmailLoading, setChangeEmailLoading] = useState(false);

  const handleChangeEmail = async (e) => {
    e.preventDefault();
    setChangeEmailLoading(true);
    try {
      await api.post('/auth/change-email', changeEmailForm);
      toast.success('Verification email sent. Check your inbox to confirm the change.');
      setShowChangeEmail(false);
      setChangeEmailForm({ new_email: '', password: '' });
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to request email change');
    } finally {
      setChangeEmailLoading(false);
    }
  };

  return (
    <>
      {/* Change Email */}
      <div className="bg-gray-900 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <Mail size={16} className="text-gray-500" />
            <h3 className="font-semibold text-white">Change Email</h3>
          </div>
          <button
            onClick={() => {
              setShowChangeEmail((v) => !v);
              setChangeEmailForm({ new_email: '', password: '' });
            }}
            className="text-sm text-primary-500 hover:text-primary-400"
          >
            {showChangeEmail ? 'Cancel' : 'Change'}
          </button>
        </div>
        <p className="text-xs text-gray-500 mb-3">Current: {user?.email}</p>
        {showChangeEmail && (
          <form onSubmit={handleChangeEmail} className="space-y-3">
            <input
              type="email"
              required
              placeholder="New email address"
              value={changeEmailForm.new_email}
              onChange={(e) =>
                setChangeEmailForm({ ...changeEmailForm, new_email: e.target.value })
              }
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-primary-500"
            />
            <input
              type="password"
              required
              placeholder="Current password to confirm"
              value={changeEmailForm.password}
              onChange={(e) => setChangeEmailForm({ ...changeEmailForm, password: e.target.value })}
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-primary-500"
            />
            <button
              type="submit"
              disabled={changeEmailLoading}
              className="w-full bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white font-semibold py-2.5 rounded-xl text-sm transition-colors"
            >
              {changeEmailLoading ? 'Sending…' : 'Send Verification Email'}
            </button>
          </form>
        )}
      </div>
    </>
  );
}
