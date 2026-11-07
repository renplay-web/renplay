import { promises as dns } from 'node:dns'
import { BlockList, isIP } from 'node:net'

/*
 * Downloads that follow addresses from a catalog (art, recipe patches) go only to the public
 * internet: never to this machine, the local network or other reserved addresses, so a hostile or
 * mistaken catalog cannot make the server probe its own network. The catalog's own hosts are
 * allowed, since an operator may run a catalog on the local network on purpose.
 */

const reserved = new BlockList()
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) reserved.addSubnet(net, bits, 'ipv4')
for (const [net, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['64:ff9b::', 96]] as const) reserved.addSubnet(net, bits, 'ipv6')

/** True for an address that is not on the public internet. */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  if (mapped) return reserved.check(mapped[1]!, 'ipv4')
  const family = isIP(address)
  return family === 4 ? reserved.check(address, 'ipv4') : family === 6 ? reserved.check(address, 'ipv6') : true
}

/** How host names are resolved (tests replace it). */
export const resolver = {
  lookup: async (host: string): Promise<string[]> => (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address),
}

async function checkPublic(url: URL, allowHosts: ReadonlySet<string>): Promise<void> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('not an http(s) address')
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (allowHosts.has(host)) return
  const addresses = isIP(host) ? [host] : await resolver.lookup(host).catch(() => {
    throw new Error(`${host} could not be found`)
  })
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new Error(`${host} is not on the public internet`)
}

/**
 * fetch() for addresses that come from a catalog: each address, and each address a redirect leads
 * to (at most three), must be on the public internet unless its host is in `allowHosts`.
 */
export async function fetchPublic(input: string | URL, init: RequestInit & { allowHosts?: ReadonlySet<string> } = {}): Promise<Response> {
  const { allowHosts = new Set(), ...rest } = init
  let url = new URL(input)
  for (let hop = 0; hop <= 3; hop++) {
    await checkPublic(url, allowHosts)
    const res = await fetch(url, { ...rest, redirect: 'manual' })
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
    if (!location) return res
    await res.body?.cancel().catch(() => {})
    url = new URL(location, url)
  }
  throw new Error('too many redirects')
}

/** The hosts of the configured catalogs, which may be on the local network. */
export function catalogHosts(urls: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const u of urls) {
    try {
      out.add(new URL(u).hostname.replace(/^\[|\]$/g, '').toLowerCase())
    } catch {}
  }
  return out
}
