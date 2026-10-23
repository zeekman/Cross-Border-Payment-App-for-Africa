import React, { useState } from 'react';
import { Activity } from 'lucide-react';
import api from '../../utils/api';

export default function RecentActivity() {

  const [activity, setActivity] = useState([]);
  const [activityLoading, setActivityLoading] = useState(true);

  React.useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/auth/activity');
        setActivity(res.data.activity || []);
      } catch {
        // non-critical, silently ignore
      } finally {
        setActivityLoading(false);
      }
    })();
  }, []);

  return (
    <>
      {/* Recent Activity */}
      <div className="bg-gray-900 rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <Activity size={16} className="text-gray-500" />
          <h3 className="font-semibold text-white">Recent Activity</h3>
        </div>
        {activityLoading ? (
          <p className="text-gray-500 text-sm text-center py-4">Loading…</p>
        ) : activity.length === 0 ? (
          <p className="text-gray-500 text-sm text-center py-4">No activity recorded yet.</p>
        ) : (
          <div className="space-y-3">
            {activity.map((event, i) => (
              <div key={i} className="flex items-start justify-between gap-3 text-sm">
                <div className="min-w-0">
                  <p className="text-white font-medium capitalize">
                    {event.action.replace(/_/g, ' ')}
                  </p>
                  <p className="text-gray-500 text-xs font-mono">{event.ip_address || '—'}</p>
                </div>
                <p className="text-gray-500 text-xs shrink-0 text-right">
                  {new Date(event.created_at).toLocaleString()}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
