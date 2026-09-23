import type { ReactNode, Ref } from "react";
import type { Me } from "../../shared/types";
import { S } from "../strings";
import { navigate } from "../router";
import { useMedia } from "../use-media";
import { HeaderCluster } from "./HeaderCluster";
import { ChevronLeftIcon, IconButton } from "./IconButton";
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
   *  (the /settings page); otherwise it is a plain lockup. It is also the
   *  bit the mobile back chevron keys off: every non-feed authenticated page
   *  sets it, the feed never does, so the chevron's presence falls out of
   *  the data rather than out of per-page discipline (AC2). */
  brandHref?: string;
  brandLinkLabel?: string;
  /** The page's OWN overflow menu, rendered at the head of .topbar-right so
   *  it sits in the app bar instead of floating in the page body (#128, the
   *  item view is the first consumer). The page keeps owning the trigger and
   *  the items — the shell stays stateless. */
  headerMenu?: ReactNode;
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

/** One app shell for App, Settings and Share: sticky topbar (back chevron +
 *  brand + actions + user menu) and a fluid main column. Login keeps its own
 *  auth layout. */
export function AppShell({
  me,
  hideHeaderAdd = false,
  hideHeaderActions = false,
  showBackToList = false,
  brandHref,
  brandLinkLabel,
  headerMenu,
  children,
  refreshing = false,
}: AppShellProps) {
  // The same JS seam the header cluster uses (#73/#125): the app renders
  // exactly ONE control per width, never a hidden duplicate, so the mobile
  // chevron is mounted at mobile width and absent above it — not display:none.
  const isDesktop = useMedia("(min-width: 640px)");
  return (
    <main className="app-shell">
      {refreshing && <div className="progress-hairline" aria-hidden="true" />}
      <header className="topbar">
        {/* #128: the mobile back affordance. Every non-feed authenticated
            page hands the shell brandHref="/", so one condition covers the
            detail, edit, add and settings screens alike (including their
            error and not-found branches, which render no cluster); the feed
            and the anonymous share surface never set it, so no chevron. The
            destination is the same as the brand link it sits beside: a
            predictable "back to the list", never history.back() (which
            exits the app on a cold deep link). #72's close icon stays gone. */}
        {!isDesktop && brandHref && (
          <IconButton
            variant="ghost"
            className="topbar-back-chevron"
            label={brandLinkLabel ?? S.settings.backToList}
            onClick={() => navigate(brandHref)}
          >
            <ChevronLeftIcon />
          </IconButton>
        )}
        <Brand href={brandHref} linkLabel={brandLinkLabel} />
        {(me || headerMenu) && (
          <div className="topbar-right">
            {headerMenu && <div className="topbar-menu">{headerMenu}</div>}
            {me && (
              <HeaderCluster
                me={me}
                hideAdd={hideHeaderAdd}
                hideActions={hideHeaderActions}
                showBackToList={showBackToList}
              />
            )}
          </div>
        )}
      </header>
      <div className="app-main">{children}</div>
    </main>
  );
}

/** Skeleton shell for the boot path (keeps the topbar + list shape).
 *
 *  `me` seeds the header cluster from the identity cache (#125): without it
 *  the boot shell paints the bare 52px lockup and the topbar grows to 66px
 *  when the identity lands, so every navigation morphs the header — the
 *  shape change #125 exists to remove. It is a PROP rather than a
 *  readStoredMe() call here because the guest share boot renders this shell
 *  too, and an anonymous surface must stay bare even when the viewer happens
 *  to have an identity cached (plan C.3, §E). */
export function AppShellLoading({ me }: { me?: Me | null }) {
  return (
    <AppShell me={me}>
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
