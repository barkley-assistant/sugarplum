interface SkeletonListProps {
  count?: number;
}

/** First-boot placeholder: shimmering card-shaped blocks. */
export function SkeletonList({ count = 3 }: SkeletonListProps) {
  return (
    <div className="skeleton-list" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton-card">
          <div className="skeleton-thumb" />
          <div className="skeleton-lines">
            <div className="skeleton-line short" />
            <div className="skeleton-line" />
          </div>
        </div>
      ))}
    </div>
  );
}