/** Only probe a local address; the public preview never contacts a LAN relay. */
export function isLocalVenueHost(hostname) {
  const host = hostname.toLowerCase();
  if (['localhost', '[::1]', '::1'].includes(host) || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return octets[0] === 127 || octets[0] === 10 || (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 169 && octets[1] === 254);
}

export async function discoverLocalVenue({origin, fetchImpl = globalThis.fetch, timeoutMs = 4000} = {}) {
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || !isLocalVenueHost(url.hostname)) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(new URL('/lan-config.json', url), {cache:'no-store', redirect:'error', signal:controller.signal});
    if (!response.ok) return null;
    const config = await response.json();
    if (config.local !== true || config.origin !== url.origin || config.protocol !== 1) return null;
    return {origin:url.origin};
  } catch {return null;}
  finally {clearTimeout(timeout);}
}
