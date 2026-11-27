# Issue 4: Scheduled Payment Warnings - Implementation Specification

## Overview
Show runs completed/max, consecutive misses, grace period, last failure reason, and warning badges for at-risk schedules. Mark missed runs in red in calendar. Add WebSocket notifications for missed runs.

## Component Files to Modify
1. `frontend/src/pages/ScheduledPayments.jsx`
2. `frontend/src/components/ScheduledPaymentsCalendar.jsx`
3. `frontend/src/components/dashboard/ScheduledPayments.jsx`

## Backend API Requirements

Ensure `/api/scheduled-payments` returns:
```json
{
  "schedules": [
    {
      "id": "sch_123",
      "next_run": "2024-02-01T09:00:00Z",
      "runs_completed": 6,
      "max_executions": 12,
      "consecutive_misses": 2,
      "max_missed_executions": 3,
      "grace_period_secs": 86400,
      "last_failure_reason": "insufficient_balance" | "insufficient_allowance" | null,
      "status": "active" | "paused" | "cancelled"
    }
  ]
}
```

## Backend WebSocket Event

When a schedule misses a run, emit via WebSocket:
```javascript
io.to(`user:${userId}`).emit('schedule:missed', {
  schedule_id: 'sch_123',
  schedule_name: 'Rent payment',
  reason: 'insufficient_balance',
  consecutive_misses: 2,
  will_cancel_after: 3
});
```

## UI Requirements

### 1. Show Runs Completed / Max
```jsx
<p>Progress: {runs_completed} of {max_executions} runs completed</p>
<ProgressBar value={runs_completed} max={max_executions} />
```

### 2. Show Missed Runs with Warning Badge
```jsx
{consecutive_misses > 0 && (
  <Alert variant="warning">
    <WarningIcon />
    {consecutive_misses} missed run{consecutive_misses > 1 ? 's' : ''} in a row
    — will be cancelled after {max_missed_executions} misses
  </Alert>
)}
```

### 3. Show Grace Window for Current Run
```jsx
const graceEndsAt = new Date(next_run).getTime() + grace_period_secs * 1000;
const isInGrace = Date.now() < graceEndsAt && Date.now() > new Date(next_run);

{isInGrace && (
  <p className="text-yellow-600">
    Grace period: {Math.floor((graceEndsAt - Date.now()) / 60000)} minutes remaining
  </p>
)}
```

### 4. Show Reason for Last Failure + Fix Action
```jsx
{last_failure_reason === 'insufficient_balance' && (
  <Alert variant="error">
    Last run failed: Insufficient balance
    <Button onClick={() => navigate('/receive')}>Top up now</Button>
  </Alert>
)}

{last_failure_reason === 'insufficient_allowance' && (
  <Alert variant="error">
    Last run failed: Allowance limit reached
    <Button onClick={reApproveAllowance}>Re-approve allowance</Button>
  </Alert>
)}
```

### 5. Mark Missed Runs in Calendar (ScheduledPaymentsCalendar.jsx)
```jsx
const getEventColor = (event) => {
  if (event.status === 'missed') return 'bg-red-500';
  if (event.status === 'completed') return 'bg-green-500';
  return 'bg-blue-500'; // upcoming
};

<div className={`${getEventColor(event)} rounded px-2 py-1`}>
  {event.title}
</div>
```

### 6. In-app Notification (listen to WebSocket event)
```jsx
useEffect(() => {
  socket.on('schedule:missed', (data) => {
    toast.error(
      `Scheduled payment "${data.schedule_name}" missed a run (${data.reason}). ` +
      `${data.consecutive_misses}/${data.will_cancel_after} misses.`,
      { 
        action: { 
          label: 'Fix now', 
          onClick: () => navigate(`/scheduled/${data.schedule_id}`) 
        } 
      }
    );
  });
  
  return () => socket.off('schedule:missed');
}, [socket]);
```

## Component Tests

```javascript
it('renders missed-run counts and remaining runs', () => {
  const mockSchedule = {
    runs_completed: 6,
    max_executions: 12,
    consecutive_misses: 2,
    max_missed_executions: 3
  };
  render(<ScheduledPaymentCard schedule={mockSchedule} />);
  expect(screen.getByText(/6 of 12/i)).toBeInTheDocument();
  expect(screen.getByText(/2 missed.*cancelled after 3/i)).toBeInTheDocument();
});

it('shows warning badge and fix action for at-risk schedules', () => {
  const mockSchedule = {
    consecutive_misses: 2,
    max_missed_executions: 3,
    last_failure_reason: 'insufficient_balance'
  };
  render(<ScheduledPaymentCard schedule={mockSchedule} />);
  expect(screen.getByRole('alert')).toHaveTextContent(/insufficient balance/i);
  expect(screen.getByRole('button', { name: /top up/i })).toBeInTheDocument();
});

it('calendar marks missed runs in red', () => {
  const events = [
    { date: '2024-01-15', status: 'completed' },
    { date: '2024-01-22', status: 'missed' },
    { date: '2024-01-29', status: 'upcoming' }
  ];
  render(<ScheduledPaymentsCalendar events={events} />);
  const missedEvent = screen.getByText('2024-01-22').closest('div');
  expect(missedEvent).toHaveClass('bg-red-500');
});
```

## Acceptance Criteria
- ✅ Missed-run counts and remaining runs render from API
- ✅ At-risk schedules show warning and fix action
- ✅ Calendar entries differ visually between missed and upcoming runs
- ✅ WebSocket notification on missed run (component test)

## Estimated Effort
6-8 hours for an experienced React developer
