import { useState } from "react";
import { displayUrl } from "../format";
import { S } from "../strings";

/** Item link row: a clean, short text link to the product (href = the
 *  full URL) plus a compact copy-link action. Raw URLs are never shown;
 *  the full URL stays reachable via the anchor's title and the copy
 *  button. Used by both the app card and the public share card. */
export function ItemLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be denied. Silent, matching SharePanel: the
      // anchor still opens the full URL and its title shows it.
    }
  }

  return (
    <div className="item-link-row">
      <a className="item-link" href={url} target="_blank" rel="noreferrer" title={url}>
        {displayUrl(url)}
      </a>
      <button type="button" className="copy-link-btn" onClick={() => void copy()}>
        {copied ? S.item.copied : S.item.copyLink}
      </button>
    </div>
  );
}
