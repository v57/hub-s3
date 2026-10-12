export type EndpointClassification =
  | {
      kind: 'public-remote'
      endpoint?: string
      reason: 'default-aws' | 'not-opted-in' | 'not-local'
    }
  | {
      kind: 'publishable-local-custom'
      endpoint: string
      host: string
      port: number
      secure: boolean
    }

export interface EndpointConfiguration {
  endpoint?: string
  publishThroughHubNetwork?: boolean
}

/**
 * Overlay publication result returned by `service.getSharePublication('s3')`.
 * Mirrors the `hub-s3-local` share-publication contract.
 */
export interface S3SharePublication {
  authority: string
  protocol: 'tcp' | 'udp'
  port: number
}

const canonicalAuthority =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.hub\.invalid$/

export function classifyEndpoint(config: EndpointConfiguration): EndpointClassification {
  const endpoint = config.endpoint?.trim()
  if (!endpoint) {
    return { kind: 'public-remote', reason: 'default-aws' }
  }
  if (!config.publishThroughHubNetwork) {
    return { kind: 'public-remote', endpoint, reason: 'not-opted-in' }
  }

  const url = parseEndpoint(endpoint)
  if (!isLoopback(url.hostname)) {
    return { kind: 'public-remote', endpoint, reason: 'not-local' }
  }

  return {
    kind: 'publishable-local-custom',
    endpoint: url.origin,
    host: url.hostname,
    port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
    secure: url.protocol === 'https:',
  }
}

function parseEndpoint(endpoint: string): URL {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new Error(`Invalid S3 endpoint '${endpoint}'`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`S3 endpoint uses unsupported protocol '${url.protocol}'`)
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Publishable S3 endpoint must be an HTTP(S) origin without credentials, path, query, or fragment')
  }
  return url
}

function isLoopback(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.').map(Number)
  return parts.length === 4 &&
    parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255) &&
    parts[0] === 127
}

/**
 * Resolve the S3 endpoint used to presign read/write URLs.
 *
 * - Public remote (default AWS, or any non-opted-in / non-loopback endpoint)
 *   returns the configured endpoint as-is, or `undefined` to let the Bun
 *   `S3Client` fall back to its `S3_ENDPOINT` environment default. Public
 *   providers are never tunneled through Hub Network.
 * - Publishable local/custom endpoints resolve to the Hub overlay authority
 *   and runtime port from the live `s3` share publication, so presigned URLs
 *   remain stable across the overlay regardless of LAN hostnames.
 *
 * Throws when overlay publication is required but unavailable, non-TCP, or
 * returns a non-canonical authority / invalid port.
 */
export function presignEndpoint(
  classification: EndpointClassification,
  publication: S3SharePublication | undefined,
): string | undefined {
  if (classification.kind !== 'publishable-local-custom') {
    return classification.endpoint
  }
  if (!publication) {
    throw new Error('Hub Network S3 share is not published')
  }
  if (publication.protocol !== 'tcp') {
    throw new Error(`Hub Network S3 share uses unsupported protocol '${publication.protocol}'`)
  }
  if (!Number.isInteger(publication.port) || publication.port < 1 || publication.port > 65_535) {
    throw new Error(`Hub Network S3 share returned invalid port '${publication.port}'`)
  }
  if (!canonicalAuthority.test(publication.authority)) {
    throw new Error(`Hub Network S3 share returned invalid authority '${publication.authority}'`)
  }
  return `http://${publication.authority}:${publication.port}`
}
