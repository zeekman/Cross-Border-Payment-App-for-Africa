import React from 'react';

/** Base shimmer block */
export function Skeleton({ className = '' }) {
  return <div className={`skeleton rounded-lg ${className}`} />;
}

/** Matches the gradient balance card on Dashboard */
export function BalanceCardSkeleton() {
  return (
    <div className="bg-gradient-to-br from-primary-600 to-primary-700 rounded-2xl p-5 shadow-lg shadow-primary-500/20">
      {/* label */}
      <Skeleton className="h-3 w-24 mb-3 opacity-50" />
      {/* big balance number */}
      <Skeleton className="h-10 w-40 mb-4 opacity-50" />
      {/* currency pills */}
      <div className="flex gap-2 mb-4">
        {[56, 48, 52, 44].map((w, i) => (
          <Skeleton key={i} className={`h-6 w-${w === 56 ? '14' : w === 48 ? '12' : w === 52 ? '13' : '11'} rounded-full opacity-40`} style={{ width: w }} />
        ))}
      </div>
      {/* address bar */}
      <Skeleton className="h-8 w-full rounded-lg opacity-40" />
    </div>
  );
}

/** Matches a single transaction row on Dashboard and TransactionHistory */
export function TransactionRowSkeleton() {
  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-xl p-3 flex items-center gap-3">
      {/* icon circle */}
      <Skeleton className="w-9 h-9 rounded-full shrink-0" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-3 w-3/5" />
        <Skeleton className="h-2.5 w-1/4" />
      </div>
      {/* amount */}
      <Skeleton className="h-4 w-16 shrink-0" />
    </div>
  );
}

/** Matches the expanded transaction card in TransactionHistory */
export function TransactionCardSkeleton() {
  return (
    <div className="bg-gray-900 rounded-xl p-4 flex items-start gap-3">
      <Skeleton className="w-10 h-10 rounded-full shrink-0" />
      <div className="flex-1 space-y-2">
        <div className="flex justify-between">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-20" />
        </div>
        <Skeleton className="h-2.5 w-2/5" />
        <div className="flex justify-between mt-2">
          <Skeleton className="h-4 w-16 rounded-full" />
          <Skeleton className="h-2.5 w-20" />
        </div>
      </div>
    </div>
  );
}
