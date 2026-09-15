import { S } from "../strings";

interface FilterChipsProps {
  /** Unique tags, sorted, derived from the union of the list's tags. */
  tags: string[];
  /** tag → item count (cheap, useful badge). */
  counts: Record<string, number>;
  /** Currently active tag, or null for "All". */
  active: string | null;
  onSelect: (tag: string | null) => void;
}

/** Client-side visibility filter (D10): selecting a chip filters the
 *  already-ordered array; it never re-sorts and never mutates source order. */
export function FilterChips({ tags, counts, active, onSelect }: FilterChipsProps) {
  if (tags.length === 0) return null;
  return (
    <div className="filter-row" role="group" aria-label={S.tags.filterLabel}>
      <button
        type="button"
        className={`filter-chip chip${active === null ? " active" : ""}`}
        onClick={() => onSelect(null)}
      >
        {S.tags.all}
      </button>
      {tags.map((tag) => (
        <button
          key={tag}
          type="button"
          className={`filter-chip chip${active === tag ? " active" : ""}`}
          onClick={() => onSelect(active === tag ? null : tag)}
        >
          <span>#{tag}</span>
          <span className="count">{counts[tag]}</span>
        </button>
      ))}
    </div>
  );
}