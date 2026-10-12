import { describe, expect, test } from 'bun:test'
import { S3Client } from 'bun'
import { classifyEndpoint, presignEndpoint } from './endpoint'

describe('S3 endpoint classification', () => {
  test('keeps default AWS public', () => {
    expect(classifyEndpoint({})).toEqual({
      kind: 'public-remote',
      reason: 'default-aws',
    })
  })

  test('keeps AWS and Wasabi endpoints public without explicit opt-in', () => {
    expect(classifyEndpoint({
      endpoint: 'https://s3.us-east-1.amazonaws.com',
    })).toEqual({
      kind: 'public-remote',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      reason: 'not-opted-in',
    })
    expect(classifyEndpoint({
      endpoint: 'https://s3.us-west-1.wasabisys.com',
      publishThroughHubNetwork: false,
    }).kind).toBe('public-remote')
  })

  test('classifies an opted-in loopback endpoint as publishable', () => {
    expect(classifyEndpoint({
      endpoint: 'http://127.0.0.1:9001',
      publishThroughHubNetwork: true,
    })).toEqual({
      kind: 'publishable-local-custom',
      endpoint: 'http://127.0.0.1:9001',
      host: '127.0.0.1',
      port: 9001,
      secure: false,
    })
  })

  test('does not turn explicit remote endpoints into implicit tunnels', () => {
    expect(classifyEndpoint({
      endpoint: 'https://s3.us-west-1.wasabisys.com',
      publishThroughHubNetwork: true,
    })).toEqual({
      kind: 'public-remote',
      endpoint: 'https://s3.us-west-1.wasabisys.com',
      reason: 'not-local',
    })
  })

  test('rejects malformed publishable endpoint configuration', () => {
    expect(() => classifyEndpoint({
      endpoint: 'ftp://127.0.0.1:9001',
      publishThroughHubNetwork: true,
    })).toThrow("unsupported protocol 'ftp:'")
    expect(() => classifyEndpoint({
      endpoint: 'http://127.0.0.1:9001/s3',
      publishThroughHubNetwork: true,
    })).toThrow('must be an HTTP(S) origin')
  })
})

// HN-512 regression: public-provider presigned URLs are never tunneled.
describe('public-provider presign endpoint (no overlay)', () => {
  test('default AWS presigns through the env-driven client, ignores publication', () => {
    const classification = classifyEndpoint({})
    expect(presignEndpoint(classification, {
      authority: 'files.v1-hub.hub.invalid',
      protocol: 'tcp',
      port: 9001,
    })).toBeUndefined()

    const url = new URL(new S3Client().presign('folder/some.txt', { method: 'GET', expiresIn: 60 }))
    expect(url.hostname).not.toMatch(/hub\.invalid$/)
  })

  test('AWS and Wasabi configured endpoints keep their public hostname in presigned URLs', () => {
    for (const endpoint of [
      'https://s3.us-east-1.amazonaws.com',
      'https://s3.us-west-1.wasabisys.com',
      'https://s3.eu-central-2.wasabisys.com',
    ]) {
      const classification = classifyEndpoint({ endpoint })
      expect(presignEndpoint(classification, undefined)).toBe(endpoint)

      const url = new URL(new S3Client({ endpoint }).presign('folder/some.txt', { method: 'GET', expiresIn: 60 }))
      expect(url.hostname).toBe(new URL(endpoint).hostname)
      expect(url.hostname).not.toMatch(/hub\.invalid$/)
    }
  })

  test('opted-in remote endpoint still presigns publicly (no implicit tunnel)', () => {
    const classification = classifyEndpoint({
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      publishThroughHubNetwork: true,
    })
    expect(classification.kind).toBe('public-remote')
    expect(presignEndpoint(classification, undefined)).toBe('https://s3.us-east-1.amazonaws.com')
  })
})

// HN-512 regression: overlay-enabled custom-provider URLs route through the
// canonical share authority and runtime port, fail closed otherwise.
describe('overlay-enabled custom-provider presign endpoint', () => {
  const publication = {
    authority: 'files-a1b2c3.v1-0123456789abcdef.hub.invalid',
    protocol: 'tcp' as const,
    port: 9001,
  }

  test('publishable loopback endpoint resolves to the overlay authority + port', () => {
    const classification = classifyEndpoint({
      endpoint: 'http://127.0.0.1:9001',
      publishThroughHubNetwork: true,
    })
    expect(presignEndpoint(classification, publication)).toBe(
      'http://files-a1b2c3.v1-0123456789abcdef.hub.invalid:9001',
    )

    const url = new URL(new S3Client({
      endpoint: presignEndpoint(classification, publication)!,
      bucket: 'hub',
    }).presign('folder/some file.txt', { method: 'GET', expiresIn: 60 }))
    expect(url.hostname).toBe('files-a1b2c3.v1-0123456789abcdef.hub.invalid')
    expect(url.port).toBe('9001')
    expect(url.pathname).toBe('/hub/folder/some%20file.txt')
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
  })

  test('fails closed until the share is published', () => {
    const classification = classifyEndpoint({
      endpoint: 'http://127.0.0.1:9001',
      publishThroughHubNetwork: true,
    })
    expect(() => presignEndpoint(classification, undefined)).toThrow('Hub Network S3 share is not published')
  })

  test('rejects non-canonical authority, non-TCP protocol, and invalid port', () => {
    const classification = classifyEndpoint({
      endpoint: 'http://127.0.0.1:9001',
      publishThroughHubNetwork: true,
    })
    expect(() => presignEndpoint(classification, {
      authority: 'public.example.com',
      protocol: 'tcp',
      port: 9001,
    })).toThrow('invalid authority')
    expect(() => presignEndpoint(classification, {
      authority: 'files.v1-hub.hub.invalid',
      protocol: 'udp',
      port: 9001,
    })).toThrow("unsupported protocol 'udp'")
    expect(() => presignEndpoint(classification, {
      authority: 'files.v1-hub.hub.invalid',
      protocol: 'tcp',
      port: 0,
    })).toThrow("invalid port '0'")
  })
})
