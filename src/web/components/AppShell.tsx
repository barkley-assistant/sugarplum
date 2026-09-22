import type { ReactNode, Ref } from "react";
import type { Me } from "../../shared/types";
import { S } from "../strings";
import { navigate } from "../router";
import { HeaderCluster } from "./HeaderCluster";
import { SkeletonList } from "./SkeletonList";

interface AppShellProps {
  /** The signed-in identity. When set, the shell renders the shared header
   *  cluster (Add + Share + avatar, #125) so every authenticated page carries
   *  the same header. Anonymous surfaces (/share/:token) and the boot
   *  skeletons leave it unset and keep the bare lockup. */
  me?: Me | null;
  /** Suppress the cluster's Add chip (the /add page). */
  hideHeaderAdd?: boolean;
  /** Suppress the cluster's Add AND Share chips (the feed's empty /
   *  other-user-list states). */
  hideHeaderActions?: boolean;
  /** Render the cluster's Back-to-list button (the item view). */
  showBackToList?: boolean;
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
  me,
  hideHeaderAdd = false,
  hideHeaderActions = false,
  showBackToList = false,
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
        {me && (
          <div className="topbar-right">
            <HeaderCluster
              me={me}
              hideAdd={hideHeaderAdd}
              hideActions={hideHeaderActions}
              showBackToList={showBackToList}
            />
          </div>
        )}
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
 *  (add/share icons, filters, share panel) compose beside it. `headingRef`
 *  lets a page focus its heading on boot (usePageFocus) — the route-change
 *  announcement without a keyboard or a scroll jump.
 *
 *  `variant="form"` switches the heading to the page scale (--text-page)
 *  instead of the feed's display scale: a form screen's title is a waypoint,
 *  and the #131 brief asks for a phone-sensible H1 there. List surfaces
 *  (feed, share view) keep the default. */
export function PageHeader({
  title,
  count,
  headingRef,
  variant,
}: {
  title: string;
  count?: number;
  headingRef?: Ref<HTMLHeadingElement>;
  variant?: "form";
}) {
  return (
    <div className="list-heading">
      <h2
        className={variant === "form" ? "page-title page-title--form" : "page-title"}
        ref={headingRef}
        tabIndex={-1}
      >
        {title}
      </h2>
      {count !== undefined && <span className="count">{S.list.itemCount(count)}</span>}
    </div>
  );
}
