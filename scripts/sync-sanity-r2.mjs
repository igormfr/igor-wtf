#!/usr/bin/env node
import crypto from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

const SANITY_PROJECT_ID = 'ty87kenq'
const SANITY_DATASET = 'production'
const SANITY_API_VERSION = '2024-01-01'
const SANITY_QUERY = `*[_type=="project"]{
  _id,title,slug,description,likes,gridRow,gridCol,tags,hasProjectPage,showName,hoverType,
  "hoverColor":hoverColor.hex,
  "titleColor":titleColor.hex,
  "titleHoverColor":titleHoverColor.hex,
  thumbnail{asset->{_id,url,size,mimeType,extension}},
  thumbnailVideo{asset->{_id,url,size,mimeType,extension,originalFilename}},
  hoverImage{asset->{_id,url,size,mimeType,extension}},
  hoverVideo{asset->{_id,url,size,mimeType,extension,originalFilename}},
  gallery[]{
    "_type":_type,layout,caption,
    asset->{_id,url,size,mimeType,extension,originalFilename}
  },
  credits[]{label,value,"url":link}
}`

const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')
const force = args.has('--force')
const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable'

loadEnv(path.join(rootDir, '.env'))

const config = {
  accountId: mustGetEnv('R2_ACCOUNT_ID'),
  accessKeyId: mustGetEnv('R2_ACCESS_KEY_ID'),
  secretAccessKey: mustGetEnv('R2_SECRET_ACCESS_KEY'),
  bucket: mustGetEnv('R2_BUCKET'),
  publicBaseUrl: mustGetEnv('R2_PUBLIC_BASE_URL').replace(/\/+$/, ''),
}

const endpoint = `https://${config.accountId}.r2.cloudflarestorage.com`

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

async function main() {
  console.log(`Mode: ${dryRun ? 'dry run' : 'sync'}`)
  console.log(`Bucket: ${config.bucket}`)
  console.log(`Public base URL: ${config.publicBaseUrl}`)

  const projects = await fetchSanityProjects()
  const {assets, snapshotProjects} = buildSnapshot(projects)
  const totals = summarizeAssets(assets)

  console.log(
    `Sanity projects: ${projects.length}; unique assets: ${assets.length}; total source size: ${formatMb(totals.totalSize)}`,
  )
  console.log(
    `Breakdown: ${totals.imageCount} images (${formatMb(totals.imageSize)}), ${totals.gifCount} GIFs (${formatMb(totals.gifSize)}), ${totals.videoCount} videos (${formatMb(totals.videoSize)})`,
  )

  if (dryRun) {
    console.log('Dry run complete: no files uploaded and no snapshot written.')
    return
  }

  const uploadResults = await uploadAssets(assets)
  await writeJson(path.join(rootDir, 'data', 'projects.snapshot.json'), snapshotProjects)
  await writeJson(path.join(rootDir, 'data', 'r2-assets-manifest.json'), {
    generatedAt: new Date().toISOString(),
    bucket: config.bucket,
    publicBaseUrl: config.publicBaseUrl,
    assets: assets.map(({sourceUrl, ...asset}) => asset),
    uploadResults,
  })

  const uploaded = uploadResults.filter((result) => result.status === 'uploaded').length
  const skipped = uploadResults.filter((result) => result.status === 'skipped').length
  console.log(`Sync complete: ${uploaded} uploaded, ${skipped} skipped.`)
  console.log('Wrote data/projects.snapshot.json and data/r2-assets-manifest.json.')
}

function loadEnv(filePath) {
  let text = ''
  try {
    text = fsSync.readFileSync(filePath, 'utf8')
  } catch (error) {
    throw new Error(`Missing ${filePath}. Fill it with the R2 credentials first.`)
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
}

function mustGetEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var ${name}`)
  return value
}

async function fetchSanityProjects() {
  const url = new URL(
    `https://${SANITY_PROJECT_ID}.apicdn.sanity.io/v${SANITY_API_VERSION}/data/query/${SANITY_DATASET}`,
  )
  url.searchParams.set('query', SANITY_QUERY)
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Sanity query failed: ${response.status} ${await response.text()}`)
  }
  const payload = await response.json()
  return payload.result || []
}

function buildSnapshot(projects) {
  const assetMap = new Map()

  function register(asset) {
    if (!asset?._id || !asset.url) return null
    const existing = assetMap.get(asset._id)
    if (existing) return existing

    const key = keyFromSanityUrl(asset.url)
    const item = {
      id: asset._id,
      key,
      r2Url: `${config.publicBaseUrl}/${key}`,
      sourceUrl: asset.url,
      size: asset.size || 0,
      mimeType: asset.mimeType || guessMimeType(asset.url),
      extension: asset.extension || extensionFromUrl(asset.url),
      originalFilename: asset.originalFilename || null,
    }
    assetMap.set(asset._id, item)
    return item
  }

  const snapshotProjects = projects.map((project) => {
    const thumbnail = register(project.thumbnail?.asset)
    const thumbnailVideo = register(project.thumbnailVideo?.asset)
    const hoverImage = register(project.hoverImage?.asset)
    const hoverVideo = register(project.hoverVideo?.asset)

    return {
      _id: project._id,
      title: project.title || '',
      slug: project.slug || null,
      description: project.description || null,
      likes: project.likes || 0,
      gridRow: project.gridRow,
      gridCol: project.gridCol,
      tags: project.tags || null,
      hasProjectPage: project.hasProjectPage,
      showName: project.showName,
      hoverType: project.hoverType,
      hoverColor: project.hoverColor || null,
      titleColor: project.titleColor || null,
      titleHoverColor: project.titleHoverColor || null,
      thumbnailUrl: thumbnail?.r2Url || null,
      thumbnailVideoUrl: thumbnailVideo?.r2Url || null,
      hoverImageUrl: hoverImage?.r2Url || null,
      hoverVideoUrl: hoverVideo?.r2Url || null,
      gallery: (project.gallery || []).map((item) => {
        const asset = register(item.asset)
        return {
          _type: item._type,
          layout: item.layout,
          caption: item.caption || null,
          url: asset?.r2Url || null,
          mimeType: asset?.mimeType || null,
        }
      }),
      credits: project.credits || null,
    }
  })

  return {assets: [...assetMap.values()], snapshotProjects}
}

function keyFromSanityUrl(url) {
  const parsed = new URL(url)
  const parts = parsed.pathname.split('/').filter(Boolean)
  const kind = parts[0] === 'files' ? 'files' : 'images'
  const filename = parts.at(-1)
  return `sanity/${kind}/${filename}`
}

async function uploadAssets(assets) {
  const results = []
  for (const [index, asset] of assets.entries()) {
    const label = `[${index + 1}/${assets.length}] ${asset.key}`
    const remote = await headObject(asset)
    if (!force && remote.exists) {
      console.log(`${label} skip`)
      results.push({id: asset.id, key: asset.key, status: 'skipped', size: asset.size})
      continue
    }

    console.log(`${label} upload`)
    const response = await fetch(asset.sourceUrl)
    if (!response.ok) {
      throw new Error(`Failed to download ${asset.sourceUrl}: ${response.status}`)
    }
    const body = Buffer.from(await response.arrayBuffer())
    await putObject(asset, body)
    results.push({id: asset.id, key: asset.key, status: 'uploaded', size: body.length})
  }
  return results
}

async function headObject(asset) {
  const response = await signedR2Request('HEAD', asset.key)
  if (response.status === 404) return {exists: false, size: 0}
  if (!response.ok) {
    throw new Error(`R2 HEAD failed for ${asset.key}: ${response.status} ${await response.text()}`)
  }
  return {exists: true, size: Number(response.headers.get('content-length') || 0)}
}

async function putObject(asset, body) {
  const response = await signedR2Request('PUT', asset.key, {
    body,
    contentType: asset.mimeType || 'application/octet-stream',
    cacheControl: ASSET_CACHE_CONTROL,
  })
  if (!response.ok) {
    throw new Error(`R2 PUT failed for ${asset.key}: ${response.status} ${await response.text()}`)
  }
}

async function signedR2Request(method, key, options = {}) {
  const url = new URL(`/${config.bucket}/${key}`, endpoint)
  const body = options.body || Buffer.alloc(0)
  const payloadHash = hashHex(body)
  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)
  const host = url.host
  const headers = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  }
  if (options.contentType) headers['content-type'] = options.contentType
  if (options.cacheControl) headers['cache-control'] = options.cacheControl

  const signedHeaders = Object.keys(headers).sort().join(';')
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((name) => `${name}:${headers[name]}\n`)
    .join('')
  const canonicalRequest = [
    method,
    encodeURI(url.pathname),
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')
  const credentialScope = `${dateStamp}/auto/s3/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    hashHex(canonicalRequest),
  ].join('\n')
  const signature = hmacHex(signingKey(config.secretAccessKey, dateStamp), stringToSign)

  headers.authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  return fetch(url, {
    method,
    headers,
    body: method === 'PUT' ? body : undefined,
  })
}

function signingKey(secret, dateStamp) {
  const kDate = hmac(Buffer.from(`AWS4${secret}`, 'utf8'), dateStamp)
  const kRegion = hmac(kDate, 'auto')
  const kService = hmac(kRegion, 's3')
  return hmac(kService, 'aws4_request')
}

function hmac(key, value) {
  return crypto.createHmac('sha256', key).update(value, 'utf8').digest()
}

function hmacHex(key, value) {
  return crypto.createHmac('sha256', key).update(value, 'utf8').digest('hex')
}

function hashHex(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function extensionFromUrl(url) {
  const pathname = new URL(url).pathname
  return path.extname(pathname).replace(/^\./, '').toLowerCase()
}

function guessMimeType(url) {
  const ext = extensionFromUrl(url)
  return (
    {
      gif: 'image/gif',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      mp4: 'video/mp4',
      png: 'image/png',
      webm: 'video/webm',
    }[ext] || 'application/octet-stream'
  )
}

function summarizeAssets(assets) {
  const totals = {
    totalSize: 0,
    imageCount: 0,
    imageSize: 0,
    gifCount: 0,
    gifSize: 0,
    videoCount: 0,
    videoSize: 0,
  }
  for (const asset of assets) {
    totals.totalSize += asset.size
    if (asset.mimeType === 'image/gif') {
      totals.gifCount += 1
      totals.gifSize += asset.size
    } else if (asset.mimeType?.startsWith('video/')) {
      totals.videoCount += 1
      totals.videoSize += asset.size
    } else if (asset.mimeType?.startsWith('image/')) {
      totals.imageCount += 1
      totals.imageSize += asset.size
    }
  }
  return totals
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), {recursive: true})
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function formatMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
