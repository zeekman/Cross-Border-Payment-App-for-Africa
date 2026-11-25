import React, { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// Locale-aware names; 2023-01-01 was a Sunday.
const weekdayNames = (locale) => {
  const fmt = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2023, 0, 1 + i)));
};
const monthNames = (locale) => {
  const fmt = new Intl.DateTimeFormat(locale, { month: 'long' });
  return Array.from({ length: 12 }, (_, i) => fmt.format(new Date(2023, i, 1)));
};

// Local-date key (avoids UTC off-by-one from toISOString()).
const dayKey = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

function advance(date, frequency) {
  const d = new Date(date);
  if (frequency === 'daily') d.setDate(d.getDate() + 1);
  else if (frequency === 'weekly') d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1); // monthly (default)
  return d;
}

/**
 * Project each scheduled payment forward over the [rangeStart, rangeEnd] window
 * from its next run date + interval. Returns a map of dayKey -> [payments].
 */
function projectOccurrences(payments, rangeStart, rangeEnd) {
  const map = {};
  payments
    .filter((p) => p.active !== false)
    .forEach((p) => {
      const base = new Date(p.next_run_at || p.next_payment_at);
      if (Number.isNaN(base.getTime())) return;
      const frequency = p.frequency || p.interval || 'monthly';

      let cursor = startOfDay(base);
      let guard = 0;
      // Skip occurrences before the visible window.
      while (cursor < rangeStart && guard < 2000) {
        cursor = advance(cursor, frequency);
        guard += 1;
      }
      // Collect occurrences inside the window.
      while (cursor <= rangeEnd && guard < 2000) {
        const key = dayKey(cursor);
        (map[key] = map[key] || []).push(p);
        cursor = advance(cursor, frequency);
        guard += 1;
      }
    });
  return map;
}

function buildMonthCells(year, month) {
  const startDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startDow; i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth; d += 1) cells.push(new Date(year, month, d));
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function buildWeekCells(anchor) {
  const start = new Date(anchor);
  start.setDate(start.getDate() - start.getDay()); // back to Sunday
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

function DayDots({ count }) {
  if (!count) return null;
  const dots = Math.min(count, 3);
  return (
    <div className="mt-1 flex items-center justify-center gap-0.5">
      {Array.from({ length: dots }).map((_, i) => (
        <span key={i} className="w-1.5 h-1.5 rounded-full bg-primary-500" />
      ))}
      {count > 3 && <span className="text-[9px] text-primary-400 ml-0.5">+{count - 3} more</span>}
    </div>
  );
}

export default function ScheduledPaymentsCalendar({ payments }) {
  const { t, i18n } = useTranslation();
  const WEEKDAYS = useMemo(() => weekdayNames(i18n.language), [i18n.language]);
  const MONTHS = useMemo(() => monthNames(i18n.language), [i18n.language]);
  const today = useMemo(() => startOfDay(new Date()), []);
  const [viewDate, setViewDate] = useState(today); // anchor for month (desktop)
  const [weekAnchor, setWeekAnchor] = useState(today); // anchor for week strip (mobile)
  const [selectedKey, setSelectedKey] = useState(null);

  // Payments are projected forward 3 months from today (issue #654).
  const occurrences = useMemo(() => {
    const rangeEnd = new Date(today);
    rangeEnd.setMonth(rangeEnd.getMonth() + 3);
    return projectOccurrences(payments, today, rangeEnd);
  }, [payments, today]);

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const monthCells = useMemo(() => buildMonthCells(year, month), [year, month]);
  const weekCells = useMemo(() => buildWeekCells(weekAnchor), [weekAnchor]);

  const goMonth = (delta) => {
    setSelectedKey(null);
    setViewDate(new Date(year, month + delta, 1));
  };
  const goWeek = (delta) => {
    setSelectedKey(null);
    const next = new Date(weekAnchor);
    next.setDate(next.getDate() + delta * 7);
    setWeekAnchor(next);
  };

  const selectedPayments = selectedKey ? occurrences[selectedKey] || [] : [];

  const renderDayCell = (date, { compact = false } = {}) => {
    if (!date) return <div className="aspect-square" />;
    const key = dayKey(date);
    const list = occurrences[key] || [];
    const hasPayments = list.length > 0;
    const isToday = key === dayKey(today);
    const isSelected = key === selectedKey;

    return (
      <button
        type="button"
        disabled={!hasPayments}
        onClick={() => setSelectedKey(isSelected ? null : key)}
        className={`relative flex flex-col items-center justify-start rounded-lg p-1 text-xs transition-colors
          ${compact ? 'min-w-[44px] h-16' : 'aspect-square'}
          ${hasPayments ? 'cursor-pointer hover:bg-gray-800' : 'cursor-default'}
          ${isSelected ? 'ring-2 ring-primary-500 bg-gray-800' : ''}
          ${isToday ? 'text-primary-400 font-bold' : 'text-gray-300'}`}
        aria-label={`${MONTHS[date.getMonth()]} ${date.getDate()}${hasPayments ? `, ${list.length} payment(s)` : ''}`}
      >
        <span className="mt-1">{date.getDate()}</span>
        <DayDots count={list.length} />
      </button>
    );
  };

  return (
    <div className="bg-gray-900 rounded-xl p-3 sm:p-4">
      {/* ── Desktop: month navigation ── */}
      <div className="hidden sm:flex items-center justify-between mb-3">
        <button type="button" onClick={() => goMonth(-1)} className="p-1.5 rounded-lg hover:bg-gray-800 text-gray-400" aria-label={t('shared.prevMonth', 'Previous month')}>
          <ChevronLeft size={18} />
        </button>
        <h3 className="text-white font-semibold">{MONTHS[month]} {year}</h3>
        <button type="button" onClick={() => goMonth(1)} className="p-1.5 rounded-lg hover:bg-gray-800 text-gray-400" aria-label={t('shared.nextMonth', 'Next month')}>
          <ChevronRight size={18} />
        </button>
      </div>

      {/* ── Mobile: week navigation ── */}
      <div className="flex sm:hidden items-center justify-between mb-3">
        <button type="button" onClick={() => goWeek(-1)} className="p-1.5 rounded-lg hover:bg-gray-800 text-gray-400" aria-label={t('shared.prevWeek', 'Previous week')}>
          <ChevronLeft size={18} />
        </button>
        <h3 className="text-white font-semibold text-sm">
          {MONTHS[weekCells[0].getMonth()]} {weekCells[0].getDate()} – {weekCells[6].getDate()}
        </h3>
        <button type="button" onClick={() => goWeek(1)} className="p-1.5 rounded-lg hover:bg-gray-800 text-gray-400" aria-label={t('shared.nextWeek', 'Next week')}>
          <ChevronRight size={18} />
        </button>
      </div>

      {/* Weekday header */}
      <div className="grid grid-cols-7 gap-1 mb-1">
        {WEEKDAYS.map((wd) => (
          <div key={wd} className="text-center text-[10px] font-medium text-gray-500">{wd}</div>
        ))}
      </div>

      {/* ── Desktop: full month grid ── */}
      <div className="hidden sm:grid grid-cols-7 gap-1">
        {monthCells.map((date, i) => (
          <React.Fragment key={i}>{renderDayCell(date)}</React.Fragment>
        ))}
      </div>

      {/* ── Mobile: condensed week-row strip ── */}
      <div className="grid sm:hidden grid-cols-7 gap-1">
        {weekCells.map((date, i) => (
          <React.Fragment key={i}>{renderDayCell(date, { compact: true })}</React.Fragment>
        ))}
      </div>

      {/* Popover: payments due on the selected day */}
      {selectedKey && selectedPayments.length > 0 && (
        <div className="mt-3 border border-gray-700 rounded-xl bg-gray-800 p-3">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-semibold text-white">
              {new Date(`${selectedKey}T00:00:00`).toLocaleDateString(i18n.language, {
                weekday: 'long', month: 'long', day: 'numeric',
              })}
            </p>
            <button type="button" onClick={() => setSelectedKey(null)} className="text-gray-400 hover:text-white" aria-label={t('shared.close', 'Close')}>
              <X size={16} />
            </button>
          </div>
          <div className="space-y-2">
            {selectedPayments.map((p, i) => (
              <div key={`${p.id}-${i}`} className="flex items-center justify-between text-sm">
                <span className="font-mono text-gray-400 text-xs">{p.recipient_wallet.slice(0, 14)}…</span>
                <span className="text-white font-medium">{p.amount} {p.asset}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
