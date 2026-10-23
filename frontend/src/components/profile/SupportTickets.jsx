import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { Plus, AlertCircle } from 'lucide-react';
import api from '../../utils/api';

export default function SupportTickets() {

  // Support tickets state (issue #481)
  const [showSupportForm, setShowSupportForm] = useState(false);
  const [supportForm, setSupportForm] = useState({ type: '', description: '', transaction_id: '' });
  const [supportLoading, setSupportLoading] = useState(false);
  const [tickets, setTickets] = useState([]);
  const [ticketsLoading, setTicketsLoading] = useState(true);

  const handleSubmitSupport = async (e) => {
    e.preventDefault();
    setSupportLoading(true);
    try {
      await api.post('/support/tickets', supportForm);
      toast.success('Support ticket created successfully');
      setShowSupportForm(false);
      setSupportForm({ type: '', description: '', transaction_id: '' });
      // Refresh tickets list
      const res = await api.get('/support/tickets');
      setTickets(res.data.tickets || []);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to create support ticket');
    } finally {
      setSupportLoading(false);
    }
  };

  React.useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/support/tickets');
        setTickets(res.data.tickets || []);
      } catch {
        // non-critical, silently ignore
      } finally {
        setTicketsLoading(false);
      }
    })();
  }, []);

  return (
    <>
      {/* Support Tickets (issue #481) */}
      <div className="bg-gray-900 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <AlertCircle size={16} className="text-primary-400" />
            <h3 className="font-semibold text-white">Support Tickets</h3>
          </div>
          <button
            onClick={() => setShowSupportForm(!showSupportForm)}
            className="text-primary-500 hover:text-primary-400 flex items-center gap-1 text-sm"
          >
            <Plus size={16} /> New Ticket
          </button>
        </div>

        {showSupportForm && (
          <form
            onSubmit={handleSubmitSupport}
            className="mb-4 space-y-3 bg-gray-800 rounded-xl p-4"
          >
            <select
              required
              value={supportForm.type}
              onChange={(e) => setSupportForm({ ...supportForm, type: e.target.value })}
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-primary-500"
            >
              <option value="">Select issue type</option>
              <option value="wrong_address">Wrong address</option>
              <option value="wrong_amount">Wrong amount</option>
              <option value="failed_deducted">Failed but deducted</option>
              <option value="other">Other</option>
            </select>
            <input
              type="text"
              placeholder="Transaction ID (optional)"
              value={supportForm.transaction_id}
              onChange={(e) => setSupportForm({ ...supportForm, transaction_id: e.target.value })}
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
            />
            <textarea
              required
              placeholder="Describe your issue..."
              value={supportForm.description}
              onChange={(e) => setSupportForm({ ...supportForm, description: e.target.value })}
              rows={3}
              maxLength={2000}
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-primary-500 resize-none"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowSupportForm(false)}
                className="flex-1 bg-gray-600 hover:bg-gray-500 text-white text-sm py-2 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={supportLoading}
                className="flex-1 bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white text-sm py-2 rounded-lg transition-colors"
              >
                {supportLoading ? 'Submitting…' : 'Submit'}
              </button>
            </div>
          </form>
        )}

        {ticketsLoading ? (
          <p className="text-gray-500 text-sm text-center py-4">Loading…</p>
        ) : tickets.length === 0 ? (
          <p className="text-gray-500 text-sm text-center py-4">No support tickets yet.</p>
        ) : (
          <div className="space-y-2">
            {tickets.map((ticket) => (
              <div key={ticket.id} className="bg-gray-800 rounded-xl px-3 py-2.5">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-semibold text-white capitalize">
                    {ticket.type.replace(/_/g, ' ')}
                  </span>
                  <span className="text-xs text-gray-500">
                    {new Date(ticket.created_at).toLocaleDateString()}
                  </span>
                </div>
                <p className="text-xs text-gray-400 line-clamp-2">{ticket.description}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
