import { Service } from 'hub-service'
import { S3Client } from 'bun'
import { LazyStates, LazyState, LazyStateIterator } from 'channel/more'

const client = new S3Client()
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
const filesState = new LazyStates((path: string) => list(path))
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
  .post('s3/read/directory', async (path: string) => {
    const list = await client.list({ prefix: path })
    return (list.contents ?? []).map(f => ({ name: f.key, lastModified: f.lastModified, size: f.size }) as FileInfo)
  })
  .post('s3/write', (path: string) => client.presign(path, readWrite))
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
