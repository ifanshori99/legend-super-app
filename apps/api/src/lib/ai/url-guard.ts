import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

// SSRF guard for the openai-compatible provider's base URL (AI_BASE_URL). In
// production (`strict`) the server may only call a public https host: no
// http, no localhost-like names, no private, loopback, link-local, CGNAT, or
// metadata addresses, whether written as an IP or behind a name that resolves
// to one. Development and tests accept them so a local model server (Ollama,
// vLLM) can be tried.
//
// Kept free of config/env.ts so env validation can use it. The provider also
// refuses redirects, so an allowed host cannot bounce the call elsewhere. A
// name that changes its answer between this check and the connection (DNS
// rebinding) is not fully covered.

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  // NAT64 could hide any IPv4 address. (IPv4-mapped ::ffff:0:0/96 is refused
  // in isBlockedIp: BlockList would match it against plain IPv4.)
  ["64:ff9b::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const)
  blocked.addSubnet(address, prefix, "ipv6");

const LOCAL_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home.arpa",
  ".intranet",
];

export function isBlockedIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return blocked.check(ip, "ipv4");
  if (version === 6)
    return ip.toLowerCase().startsWith("::ffff:") || blocked.check(ip, "ipv6");
  return true;
}

/** Why the URL may not be called, or null when it may. Synchronous. */
export function unsafeAiUrlReason(
  value: string,
  strict: boolean,
): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Base URL is not valid.";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return "Base URL must start with https://.";
  if (url.username || url.password || url.search || url.hash)
    return "Base URL must not contain credentials, parameters, or a fragment.";
  if (!strict) return null;
  if (url.protocol !== "https:")
    return "In production the base URL must use https://.";
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host))
    return isBlockedIp(host)
      ? "Base URL must not point to a local or private network address."
      : null;
  if (
    host === "localhost" ||
    !host.includes(".") ||
    LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))
  )
    return "Base URL must not point to a local or internal server.";
  return null;
}

export type HostResolver = (
  host: string,
) => Promise<{ address: string; family: number }[]>;

const defaultResolver: HostResolver = (host) =>
  lookup(host, { all: true, verbatim: true });

/** The synchronous checks plus, in production, every address the name resolves to. */
export async function checkAiUrl(
  value: string,
  strict: boolean,
  resolve: HostResolver = defaultResolver,
): Promise<string | null> {
  const reason = unsafeAiUrlReason(value, strict);
  if (reason || !strict) return reason;
  const host = new URL(value).hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return null;
  let addresses: { address: string }[];
  try {
    addresses = await resolve(host);
  } catch {
    return "Base URL host name was not found.";
  }
  if (!addresses.length) return "Base URL host name was not found.";
  return addresses.some((entry) => isBlockedIp(entry.address))
    ? "Base URL points to a local or private network address."
    : null;
}
