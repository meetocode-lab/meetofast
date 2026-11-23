import dns from 'node:dns/promises'
import net from 'node:net'
import type { NetworkPolicy } from '@meofast/shared'
import { AppError } from '../../core/errors/app-error.js'

const BLOCKED_METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata',
  'instance-data',
  '169.254.169.254',
  '100.100.100.200',
  'fd00:ec2::254',
])

function ipv4ToUint32(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let acc = 0
  for (const part of parts) {
    const n = Number(part)
    if (!Number.isInteger(n) || n < 0 || n > 255) return null
    acc = ((acc << 8) | n) >>> 0
  }
  return acc
}

function isIpv4InCidr(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split('/')
  if (!range || !bitsStr) return false
  const bits = Number(bitsStr)
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false
  const ipNum = ipv4ToUint32(ip)
  const rangeNum = ipv4ToUint32(range)
  if (ipNum === null || rangeNum === null) return false
  if (bits === 0) return true
  const mask = (~0 << (32 - bits)) >>> 0
  return (ipNum & mask) === (rangeNum & mask)
}

function unwrapMappedIpv4(address: string): string {
  const lower = address.toLowerCase()
  if (lower.startsWith('::ffff:')) {
    const rest = lower.slice(7)
    if (net.isIPv4(rest)) return rest
    // Hex form ::ffff:7f00:1
    const hexMatch = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest)
    if (hexMatch) {
      const hi = parseInt(hexMatch[1]!, 16)
      const lo = parseInt(hexMatch[2]!, 16)
      return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
    }
  }
  return lower
}

export function classifyIpAddress(rawAddress: string): {
  isMetadata: boolean
  isLoopback: boolean
  isPrivate: boolean
  normalizedIp: string
} {
  const ip = unwrapMappedIpv4(rawAddress.replace(/^\[|\]$/g, ''))

  if (net.isIPv4(ip)) {
    const isMetadata =
      isIpv4InCidr(ip, '169.254.0.0/16') || ip === '100.100.100.200' || ip === '0.0.0.0'
    const isLoopback = isIpv4InCidr(ip, '127.0.0.0/8')
    const isPrivate =
      isIpv4InCidr(ip, '10.0.0.0/8') ||
      isIpv4InCidr(ip, '172.16.0.0/12') ||
      isIpv4InCidr(ip, '192.168.0.0/16') ||
      isIpv4InCidr(ip, '100.64.0.0/10')

    return { isMetadata, isLoopback, isPrivate, normalizedIp: ip }
  }

  // IPv6 classification
  const lower = ip.toLowerCase()
  const isLoopback = lower === '::1' || lower === '0:0:0:0:0:0:0:1' || lower === '::'
  const isMetadata =
    lower === 'fd00:ec2::254' || lower.startsWith('fe80:') || lower.startsWith('fe9')
  const isPrivate = lower.startsWith('fc') || lower.startsWith('fd')

  return { isMetadata, isLoopback, isPrivate, normalizedIp: lower }
}

function matchesDomainAllowlist(hostname: string, allowedDomains: string[]): boolean {
  const lowerHost = hostname.toLowerCase()
  for (const pattern of allowedDomains) {
    const clean = pattern.trim().toLowerCase()
    if (!clean) continue
    if (clean.startsWith('*.')) {
      const suffix = clean.slice(1) // '.corp.internal'
      if (lowerHost.endsWith(suffix) && lowerHost.length > suffix.length) return true
    } else if (lowerHost === clean) {
      return true
    }
  }
  return false
}

function matchesCidrAllowlist(ip: string, allowedCidrs: string[]): boolean {
  if (!net.isIPv4(ip)) return false
  return allowedCidrs.some((cidr) => isIpv4InCidr(ip, cidr.trim()))
}

export async function validateOutboundTargetUrl(
  rawUrl: string,
  policy: NetworkPolicy,
  customLookup?: (hostname: string) => Promise<Array<{ address: string }>>,
): Promise<URL> {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new AppError(400, 'INVALID_TARGET_URL', `Invalid target URL: ${rawUrl}`)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError(
      400,
      'UNSUPPORTED_PROTOCOL',
      `Unsupported protocol '${parsed.protocol}'. Only http:// and https:// are permitted.`,
    )
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!hostname) {
    throw new AppError(400, 'INVALID_TARGET_URL', 'Target URL is missing a valid hostname.')
  }

  if (BLOCKED_METADATA_HOSTS.has(hostname)) {
    throw new AppError(
      403,
      'SSRF_METADATA_BLOCKED',
      `Access to cloud metadata endpoint '${hostname}' is unconditionally blocked.`,
    )
  }

  const domainWhitelisted = matchesDomainAllowlist(hostname, policy.allowedDomains)

  let resolvedAddresses: string[] = []
  if (net.isIP(hostname) !== 0) {
    resolvedAddresses = [hostname]
  } else {
    const lookupFn = customLookup ?? ((h: string) => dns.lookup(h, { all: true }))
    try {
      const records = await lookupFn(hostname)
      resolvedAddresses = records.map((r) => r.address)
    } catch {
      throw new AppError(
        502,
        'DNS_RESOLUTION_FAILED',
        `Could not resolve hostname '${hostname}'. Check the URL or DNS settings.`,
      )
    }
  }

  if (resolvedAddresses.length === 0) {
    throw new AppError(502, 'DNS_RESOLUTION_FAILED', `No IP addresses resolved for '${hostname}'.`)
  }

  for (const addr of resolvedAddresses) {
    const cls = classifyIpAddress(addr)

    // Cloud metadata & link-local are ALWAYS blocked regardless of admin policy
    if (cls.isMetadata) {
      throw new AppError(
        403,
        'SSRF_METADATA_BLOCKED',
        `Target '${hostname}' resolved to restricted cloud metadata/link-local address (${cls.normalizedIp}).`,
      )
    }

    if (cls.isLoopback) {
      const allowed =
        policy.allowLocalhost ||
        domainWhitelisted ||
        matchesCidrAllowlist(cls.normalizedIp, policy.allowedCidrs)
      if (!allowed) {
        throw new AppError(
          403,
          'SSRF_LOOPBACK_BLOCKED',
          `Target '${hostname}' (${cls.normalizedIp}) is a localhost/loopback address. An administrator can enable Localhost Access in Admin -> Network Security if testing local services.`,
        )
      }
    }

    if (cls.isPrivate) {
      const allowed =
        policy.allowPrivateNetworks ||
        domainWhitelisted ||
        matchesCidrAllowlist(cls.normalizedIp, policy.allowedCidrs)
      if (!allowed) {
        throw new AppError(
          403,
          'SSRF_PRIVATE_NETWORK_BLOCKED',
          `Target '${hostname}' (${cls.normalizedIp}) resolves to a private internal network. An administrator can authorize private networks or CIDRs in Admin -> Network Security.`,
        )
      }
    }
  }

  return parsed
}
