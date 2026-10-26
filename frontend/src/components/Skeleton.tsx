/** A neutral shimmer block used while a panel's first fetch is in flight. */
export function Skeleton({ className = '' }: { className?: string }) {
  return <span className={`skeleton ${className}`} aria-hidden="true" />;
}
