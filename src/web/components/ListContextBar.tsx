import type { Me } from "../../shared/types";
import { navigate } from "../router";
import { useWishlistSummary } from "../use-summary";
import { setFeedViewingHandoff } from "../feed-handoff";
import { ListSwitcher } from "./ListSwitcher";

/** #125: the context bar every non-feed authenticated page carries as its
 *  first content row — the compact list switcher, at the same position the
 *  feed's own switcher occupies (top of the content column, under the
 *  topbar). It answers the question the stripped pages used to leave open:
 *  WHICH list am I looking at, and how do I get to another one.
 *
 *  Selecting a list hands the choice to the feed and navigates there (there
 *  is no route for "the feed is showing user X" — see feed-handoff): from a
 *  detail page, picking a list means going to that list's feed. */
export function ListContextBar({ me }: { me: Me }) {
  const summary = useWishlistSummary(me);
  const displayName = me.displayName || me.username;
  const ownCount = summary.find((row) => row.userId === me.id)?.itemCount ?? 0;

  const rows = [
    { userId: me.id, displayName, itemCount: ownCount },
    ...summary
      .filter((row) => row.userId !== me.id)
      .map((row) => ({ userId: row.userId, displayName: row.displayName, itemCount: row.itemCount }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
  ];

  return (
    <ListSwitcher
      variant="compact"
      currentName={displayName}
      rows={rows}
      currentUserId={null}
      count={ownCount}
      onSelect={(userId) => {
        setFeedViewingHandoff(userId);
        navigate("/");
      }}
    />
  );
}
