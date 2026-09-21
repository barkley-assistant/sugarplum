import type { ReactNode } from "react";
import type { PriceHintState } from "../../shared/types";
import { formatPrice, urlHost } from "../format";
import { S } from "../strings";

interface HintsPanelProps {
  itemId: string;
  open: boolean;
  onToggle: () => void;
  hintState?: PriceHintState;
}

/** Owner-only prices-elsewhere disclosure for the detail surface. Results are
 * explicitly presented as unverified candidates, never as a comparison. */
export function HintsPanel({ itemId, open, onToggle, hintState }: HintsPanelProps) {
  return (
    <div className="hint-block">
      <button
        type="button"
        className="detail-row hints-toggle"
        aria-expanded={open}
        aria-controls={`hints-${itemId}`}
        onClick={onToggle}
      >
        <SearchIcon />
        <span>{S.detail.checkElsewhere}</span>
        <ChevronRightIcon />
      </button>
      {open && (
        <div className="hint-candidates" id={`hints-${itemId}`}>
          {(!hintState || hintState.status === "loading") && (
            <p className="muted">{S.item.checkingPrices}</p>
          )}
          {hintState?.status === "error" && <p className="muted">{S.errors.checkPrices}</p>}
          {hintState?.status === "done" && hintState.disabled && (
            <p className="muted">{S.item.hintsDisabled}</p>
          )}
          {hintState?.status === "done" && !hintState.disabled && hintState.hints.length === 0 && (
            <p className="muted">{S.item.hintsNone}</p>
          )}
          {hintState?.status === "done" && !hintState.disabled && hintState.hints.length > 0 && (
            <div className="hints-rows">
              {hintState.hints.map((candidate) => (
                <div className="hints-row" key={candidate.sourceUrl}>
                  <a
                    href={candidate.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    referrerPolicy="no-referrer"
                    title={candidate.sourceTitle}
                  >
                    <span className="hint-price-now">{formatPrice(candidate.priceCents, candidate.currency)}</span>
                    <span className="hint-host">{urlHost(candidate.sourceUrl)}</span>
                    <span className="hint-note">{S.item.hintCandidateNote}</span>
                  </a>
                </div>
              ))}
            </div>
          )}
          <p className="hint-footnote">{S.item.hintsFootnote}</p>
        </div>
      )}
    </div>
  );
}

function Icon({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">{children}</svg>;
}

function SearchIcon() {
  return <Icon><circle cx="8.7" cy="8.7" r="4.5" stroke="currentColor" strokeWidth="1.5" /><path d="m12.1 12.1 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></Icon>;
}

function ChevronRightIcon() {
  return <Icon size={16}><path d="m7.5 4 5 6-5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></Icon>;
}
