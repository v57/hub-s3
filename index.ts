import { Service } from 'hub-service'
import { S3Client } from 'bun'
import { LazyState } from 'channel/more'

const client = new S3Client()
let statuses: Record<string, FileStatus | undefined> = {}

async function list(prefix?: string): Promise<Files> {
  const list = await client.list({ prefix, delimiter: '/' })
  return {
    count: list.keyCount ?? 0,
    files: (list.contents ?? []).map(f => ({ name: f.key, lastModified: f.lastModified, size: f.size }) as FileInfo),
    directories: list.commonPrefixes?.map(a => a.prefix) ?? [],
  }
}

const filesState = new LazyState<Files>(() => list())
const statusState = new LazyState(() => statuses)

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

new Service()
  .post('s3/read', (path: string) => client.presign(path, read))
  .post('s3/write', (path: string) => client.presign(path, readWrite))
  .post('s3/delete', (path: string) => client.delete(path, readWrite))
  .post('s3/size', (path: string) => client.size(path))
  .post('s3/list', async (prefix?: string) => list(prefix))
  .post('s3/updated', async () => filesState.setNeedsUpdate())
  .post('s3/update/status', async ({ path, status }) => {
    if (status) {
      statuses[path] = status
    } else {
      delete statuses[path]
    }
    filesState.setNeedsUpdate()
  })
  .stream('s3/list', () => filesState.makeIterator())
  .stream('s3/status', () => statusState.makeIterator())
  .start()
