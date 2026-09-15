/**
 * SSRF guard helpers for outbound fetches (scrape + product-image download).
 *
 * Two layers:
 *   - Hard check: the URL's host is a LITERAL private/loopback IP. Decided
 *     locally, never touches the network.
 *   - Soft check: a NON-literal hostname gets one DNS lookup; if any resolved
 *     address is private, the target is rejected. Best-effort by design —
 *     a lookup failure is not treated as evidence of a private address (the
 *     literal checks are the guarantee; DNS rebinding cannot be fully solved
 *     at this layer).
 *
 * Ranges blocked: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
 * 169.254.0.0/16, ::1, fc00::/7, plus IPv4-mapped IPv6 (::ffff:0:0/96) which
 * would otherwise bypass the IPv4 rules.
 */

import { isIP } from "node:net";

/** URL hostname for IPv6 literals includes the brackets ("[::1]"). */
function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isPrivateIpv4(ip: string): boolean {
  const [a, b] = ip.split(".").map((octet) => Number(octet));
  return (
    a === 127 || // 127.0.0.0/8 loopback
    a === 10 || // 10.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 169 && b === 254) // 169.254.0.0/16 link-local
  );
}

/** Splits a validated IPv6 literal into 8 lowercase hextets ("0000"-padded);
 *  an embedded IPv4 dotted quad is kept as a single part. */
function ipv6Parts(ip: string): string[] {
  const lower = ip.toLowerCase();
  const [head, tail] = lower.includes("::") ? lower.split("::") : [lower, ""];
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const fill = 8 - headParts.length - tailParts.length;
  if (fill < 0) return [];
  return [...headParts, ...Array<string>(fill).fill("0000"), ...tailParts].map((part) =>
    part.includes(".") ? part : part.padStart(4, "0"),
  );
}

function isPrivateIpv6(ip: string): boolean {
  const parts = ipv6Parts(ip);
  if (parts.length !== 8) return false;

  // ::1 loopback.
  if (parts.slice(0, 7).every((part) => part === "0000") && parts[7] === "0001") return true;

  // fc00::/7 unique-local: first hextet fc00-fdff.
  const first = parseInt(parts[0], 16);
  if ((first & 0xfe00) === 0xfc00) return true;

  // IPv4-mapped (::ffff:0:0/96): apply the IPv4 rules to the mapped address.
  const ffff = parts.indexOf("ffff");
  if (ffff >= 5 && parts.slice(0, ffff).every((part) => part === "0000")) {
    const after = parts.slice(ffff + 1);
    if (after.length === 1) {
      // Dotted-quad form, e.g. "::ffff:127.0.0.1".
      return isPrivateIpv4(after[0]);
    }
    if (after.length === 2) {
      // Hex form, e.g. "::ffff:7f00:1".
      const n = parseInt(`${after[0]}${after[1]}`, 16);
      return isPrivateIpv4(`${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`);
    }
  }
  return false;
}

/** True when the hostname is a literal IP (IPv4 dotted-quad or IPv6) that
 *  falls inside a private/loopback range. Never throws. */
export function isLiteralPrivateHost(hostname: string): boolean {
  const bare = stripBrackets(hostname);
  const family = isIP(bare);
  if (family === 4) return isPrivateIpv4(bare);
  if (family === 6) return isPrivateIpv6(bare);
  return false;
}

/** Pre-fetch check: the URL's host is a literal private IP → reject. Never
 *  throws (a malformed URL will simply fail as 'network' later). */
export function isPrivateLiteralUrl(urlStr: string): boolean {
  try {
    return isLiteralPrivateHost(new URL(urlStr).hostname);
  } catch {
    return false;
  }
}

/**
 * Post-fetch check on the FINAL url (redirects were already followed):
 * literal private → reject; literal public IP → allow without DNS; a
 * hostname → one DNS lookup, any private address → reject. Never throws.
 */
export async function finalUrlIsPrivate(urlStr: string): Promise<boolean> {
  let bare: string;
  try {
    bare = stripBrackets(new URL(urlStr).hostname);
  } catch {
    return false;
  }
  if (isLiteralPrivateHost(bare)) return true;
  if (isIP(bare) > 0) return false; // literal public IP — no DNS needed
  try {
    const results = await Bun.dns.lookup(bare, { family: 0 });
    return results.some((r) => isLiteralPrivateHost(r.address));
  } catch {
    // Lookup failure isn't evidence of a private address; the fetch already
    // succeeded, so do not reject on our resolver's trouble alone.
    return false;
  }
}