import { Clock } from 'lucide-react';

export default function ScheduledPayments({ navigate, scheduledPayments, scheduledLoading }) {
  return (
    <>
      {/* Upcoming Scheduled Payments */}
      {(scheduledLoading || scheduledPayments.length > 0) && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-gray-900 dark:text-white">Upcoming Payments</h3>
            <button
              onClick={() => navigate('/scheduled')}
              className="text-primary-500 text-sm hover:underline"
            >
              See all
            </button>
          </div>
          {scheduledLoading ? (
            <div className="space-y-2">
              {[0, 1].map((i) => (
                <div key={i} className="skeleton h-14 rounded-xl" />
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {scheduledPayments.map((p) => (
                <div
                  key={p.id}
                  className="bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-xl p-3 flex items-center gap-3 shadow-sm"
                >
                  <div className="w-9 h-9 rounded-full bg-primary-500/10 text-primary-400 flex items-center justify-center shrink-0">
                    <Clock size={16} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                      {p.recipient_wallet.slice(0, 8)}…{p.recipient_wallet.slice(-4)}
                    </p>
                    <p className="text-xs text-gray-500 capitalize">
                      {p.frequency} · Next: {new Date(p.next_run_at).toLocaleDateString()}
                    </p>
                  </div>
                  <span className="text-sm font-semibold text-primary-400 shrink-0">
                    {p.amount} {p.asset}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
