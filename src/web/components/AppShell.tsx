import type { ReactNode } from "react";
import { S } from "../strings";
import { navigate } from "../router";
import { SkeletonList } from "./SkeletonList";

interface AppShellProps {
  /** Right side of the topbar (the UserMenu). */
  headerRight?: ReactNode;
  /** Compact actions beside the user menu (add/share icon buttons). */
  headerActions?: ReactNode;
  /** When set, the brand renders as a home link with this accessible name
   *  (the /settings page); otherwise it is a plain lockup. */
  brandHref?: string;
  brandLinkLabel?: string;
  children: ReactNode;
  refreshing?: boolean;
}

function Brand({ href, linkLabel }: { href?: string; linkLabel?: string }) {
  const lockup = (
    <>
      <img className="brand-mark" src="/assets/brand/pwa/favicon-32.png" alt="" />
      <h1 className="brand-name">{S.app.name}</h1>
    </>
  );
  if (href) {
    return (
      <a
        className="brand"
        href={href}
        aria-label={linkLabel ?? S.settings.backToList}
        onClick={(e) => {
          // In-app targets navigate through the router (no document load);
          // modified clicks keep the browser's own behaviour.
          if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
            return;
          }
          e.preventDefault();
          navigate(href);
        }}
      >
        {lockup}
      </a>
    );
  }
  return <div className="brand">{lockup}</div>;
}

/** One app shell for App, Settings and Share: sticky topbar (brand +
 *  actions + user menu) and a fluid main column. Login keeps its own auth
 *  layout. */
export function AppShell({
  headerRight,
  headerActions,
  brandHref,
  brandLinkLabel,
  children,
  refreshing = false,
}: AppShellProps) {
  return (
    <main className="app-shell">
      {refreshing && <div className="progress-hairline" aria-hidden="true" />}
      <header className="topbar">
        <Brand href={brandHref} linkLabel={brandLinkLabel} />
        <div className="topbar-right">
          {headerActions && <div className="topbar-actions">{headerActions}</div>}
          {headerRight}
        </div>
      </header>
      <div className="app-main">{children}</div>
    </main>
  );
}

/** Skeleton shell for the boot path (keeps the topbar + list shape). */
export function AppShellLoading() {
  return (
    <AppShell>
      <SkeletonList />
    </AppShell>
  );
}

/** Content-driven page heading: title + tabular count. Page-level actions
 *  (add/share icons, filters, share panel) compose beside it. */
export function PageHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="list-heading">
      <h2 className="page-title">{title}</h2>
      {count !== undefined && <span className="count">{S.list.itemCount(count)}</span>}
    </div>
  );
}
