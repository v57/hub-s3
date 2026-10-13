import { Service } from 'hub-service'
import { S3Client } from 'bun'
import { LazyStates, LazyState } from 'channel/more'
import { classifyEndpoint, presignEndpoint, type EndpointConfiguration } from './endpoint'

const endpointConfig: EndpointConfiguration = {
  endpoint: process.env.S3_ENDPOINT,
  publishThroughHubNetwork: process.env.S3_PUBLISH_THROUGH_HUB_NETWORK === 'true',
}
const endpointClassification = classifyEndpoint(endpointConfig)

// Public providers (default AWS, Wasabi, or any non-opted-in / non-loopback
// endpoint) stay public: env-driven S3Client, no Hub Network share. List,
// delete, and size always use this client so non-presign operations keep
// working identically to the pre-network behavior.
const client = new S3Client()

// Presigning client. For publishable local/custom endpoints it is rebuilt
// per request from the live share publication so reconnects/republished
// ports are reflected without restarting the service. Public providers
// presign through the env-driven `client` above (no overlay).
const presignClient = () => endpointClassification.kind === 'publishable-local-custom'
  ? new S3Client({ endpoint: presignEndpoint(endpointClassification, service.getSharePublication('s3')) })
  : client

let statuses: Record<string, FileStatus | undefined> = {}

async function list(prefix?: string): Promise<Files> {
  const list = await client.list({ prefix, delimiter: '/' })
  const slice = prefix?.length ?? 0
  return {
    count: list.keyCount ?? 0,
    files: (list.contents ?? []).map(
      f => ({ name: f.key.slice(slice), lastModified: f.lastModified, size: f.size }) as FileInfo,
    ),
    directories: list.commonPrefixes?.map(a => a.prefix.slice(slice)) ?? [],
  }
}
function getParent(path: string) {
  if (path.length === 0) return path
  const split = path.split('/')
  const directory = split.slice(0, split.at(-1) === '' ? -2 : -1).join('/')
  return directory.length === 0 ? directory : directory + '/'
}
const filesState = new LazyStates((path: string) => list(path)).dedupe('equals')
const statusState = new LazyState(() => statuses).dedupe('json')

interface Files {
  count: number
  files: FileInfo[]
  directories: string[]
}
interface FileInfo {
  name: string
  size: number
  lastModified?: string
}
interface FileStatus {
  name: 'Uploading' | 'Processing'
  progress: number
}

const read: Bun.S3FilePresignOptions = { acl: 'public-read', method: 'GET', expiresIn: 86400 * 7 }
const readWrite: Bun.S3FilePresignOptions = { acl: 'public-read-write', method: 'PUT', expiresIn: 86400 * 7 }

const service = new Service({ name: 'S3 Storage', icon: { symbol: 'folder', text: 'S3' } })

// Only publishable local/custom endpoints declare a Hub Network share.
// Public providers (AWS, Wasabi, default) never publish and never tunnel.
if (endpointClassification.kind === 'publishable-local-custom') {
  service.share('s3', 'tcp', endpointClassification.host, endpointClassification.port, { mode: 'hub' })
}

service
  .post('s3/read', (path: string) => presignClient().presign(path, read))
  .post('s3/read/directory', async (path: string) => {
    const list = await client.list({ prefix: path })
    return (list.contents ?? []).map(f => ({ name: f.key, lastModified: f.lastModified, size: f.size }) as FileInfo)
  })
  .post('s3/write', (path: string) => presignClient().presign(path, readWrite))
  .post('s3/delete', async (path: string) => {
    if (path.endsWith('/')) {
      const files = await client.list({ prefix: path })
      if (files.contents) {
        await Promise.all(
          files.contents.map(file =>
            client.delete(file.key).then(() => filesState.setNeedsUpdate(getParent(file.key))),
          ),
        )
        filesState.setNeedsUpdate(getParent(path))
      }
    } else {
      await client.delete(path)
      filesState.setNeedsUpdate(getParent(path))
    }
  })
  .post('s3/size', (path: string) => client.size(path))
  .post('s3/list', async (prefix?: string) => list(prefix))
  .post('s3/updated', async (path?: string) => filesState.setNeedsUpdate(path ?? ''))
  .post('s3/update/status', async ({ path, status }) => {
    if (status) {
      statuses[path] = status
    } else {
      delete statuses[path]
    }
    statusState.setNeedsUpdate()
  })
  .stream('s3/list', (body?: string) => filesState.makeIterator(body ?? ''))
  .stream('s3/status', () => statusState.makeIterator())
  .start()

console.log(await list())
