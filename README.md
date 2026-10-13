<h1>
  <img alt="Containerization logo" src="./icon.png" width="70" valign="middle">
  &nbsp;hub-s3
</h1>

> Made for [Hub](https://hub.v57.dev)

Share S3 server with your Hub network

AWS, Wasabi, and other remote S3 endpoints remain public by default. Hub
Network publication requires explicit opt-in and a loopback HTTP(S) endpoint;
remote endpoints are never implicitly tunneled.

## Download file

```ts
const url: string = await service.send('s3/read', 'folder/some.txt')
const data = await fetch(url)
```
## Upload file

```ts
const url: string = await service.send('s3/write', 'folder/some.txt')
await fetch(url, { method: 'PUT', body: Bun.file('some.txt') })
// Send completion request to notify everyone who is listening to this folder
await service.send('s3/updated', 'folder/')
// You use same url to download it
const file = await fetch(url)
```
## Get file size

```ts
const size: number = await service.send('s3/size', 'folder/some.txt')
```
## Delete file
```ts
await service.send('s3/delete', 'folder/some.txt')
```
### Delete folder
```ts
await service.send('s3/delete', 'folder/')
```
## Realtime updates
```ts
const path: string | undefined
for (await const files: Files of service.values('s3/list', path)) {
	
}
```
## Upload status

```ts
// Set status
const status: FileStatus = { name: 'Uploading', progress: 0.5 }
await service.send('s3/update/status', { path: 'some.txt', status })
// Clear status
await service.send('s3/update/status', { path: 'some.txt' })
```
## Status stream

```ts
for (await const statuses of service.values('s3/status')) {
  // Record<string, FileStatus | undefined>
}
```

## Types
```ts
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
```
