import { S } from "../strings";
import { GearIcon, ListIcon, PlusIcon } from "./IconButton";

interface ActionBarProps {
  /** Navigates to the lists screen (the feed route, "/"). */
  onList: () => void;
  /** Navigates to /add. */
  onAdd: () => void;
  /** Navigates to /settings. */
  onSettings: () => void;
  /** #95/#96: the bar destination matching the current route ("home" |
   *  "add" | "settings"), or null when the route is not a bar destination
   *  (item pages). Drives aria-current + the .is-current accent — the hook
   *  #73 left dormant for the cross-route navigator this bar now is.
   *  EXACT match only (#96): a family match would light List on a
   *  /items/:id... route while go() no-ops there, a lit-but-dead button. */
  currentDestination?: "home" | "add" | "settings" | null;
}

/** Mobile-only bottom action bar (#73, made persistent by #95): outline
 *  icons with a small label beneath, borderless buttons, one hairline
 *  divider on the bar's top edge, the app background behind it, and
 *  safe-area padding below. Rendered by AppBottomBar — Root-level shell
 *  chrome — on every AUTHENTICATED route below 640px; /share/:token and
 *  /login render no bar.
 *
 *  Semantics: a <nav> landmark with three buttons, all of them navigation
 *  destinations — List (the lists screen), Add, Settings. The one matching
 *  the current route carries aria-current="page" plus the .is-current
 *  accent (#95 activates the hook #73 left dormant) under the exact-match
 *  rule #96 established. Share is NOT a bar item any more (#184): it moved
 *  into the avatar menu, where a labelled row can carry the action without
 *  pretending a navigator navigates somewhere.
 *
 *  Mount point: AppBottomBar renders this as a sibling of the route view
 *  inside #root, which — like .app-shell/.app-main — creates no containing
 *  block for fixed descendants (no transform/filter/backdrop-filter), so
 *  the bar is fixed against the viewport. It must NOT move into .topbar,
 *  whose backdrop-filter WOULD clip it. Visibility is CSS-gated to the
 *  same <640px range the caller renders it for (`.action-bar { display:
 *  none }` above that). */
export function ActionBar({
  onList,
  onAdd,
  onSettings,
  currentDestination = null,
}: ActionBarProps) {
  return (
    <nav className="action-bar" aria-label={S.bar.navigation}>
      {/* #129: the visible label is the short "Add" (S.bar.add) so /add never
          shows two elements reading "Add item"; the accessible name stays the
          app's full phrase via aria-label. */}
      <button
        type="button"
        className={`action-bar-item${currentDestination === "add" ? " is-current" : ""}`}
        aria-current={currentDestination === "add" ? "page" : undefined}
        aria-label={S.list.addItem}
        onClick={onAdd}
      >
        <PlusIcon />
        <span className="action-bar-label">{S.bar.add}</span>
      </button>
      <button
        type="button"
        className={`action-bar-item${currentDestination === "home" ? " is-current" : ""}`}
        aria-current={currentDestination === "home" ? "page" : undefined}
        aria-label={S.bar.list}
        onClick={onList}
      >
        <ListIcon />
        <span className="action-bar-label">{S.bar.list}</span>
      </button>
      <button
        type="button"
        className={`action-bar-item${currentDestination === "settings" ? " is-current" : ""}`}
        aria-current={currentDestination === "settings" ? "page" : undefined}
        onClick={onSettings}
      >
        <GearIcon />
        <span className="action-bar-label">{S.bar.settings}</span>
      </button>
    </nav>
  );
}
