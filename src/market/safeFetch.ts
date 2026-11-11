import dns from "dns";
import net from "net";
import { Agent, fetch as undiciFetch } from "undici";

/**
 * Outbound fetch for creator-supplied URLs. Only public HTTPS hosts on port 443.
 * The address check runs inside the connection's DNS lookup, so a hostname that
 * re-resolves to a private address between validation and connect (DNS
 * rebinding) is still refused.
 */

const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

export function isPublicAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const value = v4ToInt(ip);
    return !BLOCKED_V4.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (value & mask) === (v4ToInt(base) & mask);
    });
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::" || lower === "::1") return false;
    if (lower.startsWith("::ffff:")) return isPublicAddress(lower.slice(7));
    if (/^f[cd]/.test(lower)) return false; // unique local
    if (/^fe[89ab]/.test(lower)) return false; // link local
    if (lower.startsWith("ff")) return false; // multicast
    return true;
  }
  return false;
}

export function validateCreatorUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("upstream_url is not a valid URL.");
  }
  if (url.protocol !== "https:") throw new Error("upstream_url must use https.");
  if (url.port && url.port !== "443") throw new Error("upstream_url must use the default HTTPS port.");
  if (url.username || url.password) throw new Error("upstream_url must not contain credentials.");
  if (net.isIP(url.hostname) || url.hostname.startsWith("[") || url.hostname === "localhost" || url.hostname.endsWith(".local") || url.hostname.endsWith(".internal")) {
    throw new Error("upstream_url must use a public hostname.");
  }
  return url;
}

const guardedAgent = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return callback(err, "", 4);
        const list = Array.isArray(addresses) ? addresses : [{ address: addresses as unknown as string, family: 4 }];
        const blocked = list.find((a) => !isPublicAddress(a.address));
        if (blocked || !list.length) {
          return callback(new Error(`Refusing to connect to non-public address for ${hostname}.`), "", 4);
        }
        if ((options as any).all) return (callback as any)(null, list);
        callback(null, list[0].address, list[0].family);
      });
    },
  },
});

export interface SafeResponse {
  status: number;
  contentType: string;
  body: Uint8Array;
}

export async function safeCreatorFetch(
  url: string,
  init: { method: string; headers: Record<string, string>; body: Uint8Array; timeoutMs: number; maxBytes: number }
): Promise<SafeResponse> {
  validateCreatorUrl(url);
  const res = await undiciFetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    redirect: "manual",
    dispatcher: guardedAgent,
    signal: AbortSignal.timeout(init.timeoutMs),
  });
  if (res.status >= 300 && res.status < 400) throw new Error("Creator endpoint redirected; redirects are not followed.");
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > init.maxBytes) {
        await reader.cancel();
        throw new Error(`Creator response exceeded ${init.maxBytes} bytes.`);
      }
      chunks.push(value);
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return { status: res.status, contentType: res.headers.get("content-type") ?? "application/octet-stream", body };
}
