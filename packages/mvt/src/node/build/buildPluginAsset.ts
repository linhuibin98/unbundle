import path from 'pathe'
import fs from 'fs-extra'
import { isStaticAsset } from '../utils/index'
import hash from 'hash-sum'
import slash from 'slash'
import mime from 'mime-types'

import type { Plugin, OutputBundle } from 'rollup'

const debug = require('debug')('mvt:build:asset')

interface AssetCacheEntry {
  content: Buffer
  fileName: string
  url: string
}

const assetResolveCache = new Map<string, AssetCacheEntry>()

export const resolveAsset = async (
  id: string,
  publicBase: string,
  assetsDir: string,
  inlineLimit: number
): Promise<AssetCacheEntry> => {
  const cached = assetResolveCache.get(id)
  if (cached) {
    return cached
  }

  const ext = path.extname(id)
  const baseName = path.basename(id, ext)
  const resolvedFileName = `${baseName}.${hash(slash(id))}${ext}`

  let url = slash(path.join(publicBase, assetsDir, resolvedFileName))
  const content = await fs.readFile(id)
  if (!id.endsWith(`.svg`) && content.length < inlineLimit) {
    url = `data:${mime.lookup(id)};base64,${content.toString('base64')}`
  }

  const resolved = {
    content,
    fileName: resolvedFileName,
    url
  }

  assetResolveCache.set(id, resolved)
  return resolved
}

export const registerAssets = (
  assets: Map<string, string>,
  bundle: OutputBundle
) => {
  for (const [fileName, source] of assets) {
    bundle[fileName] = {
      type: 'asset',
      fileName,
      name: fileName,
      source,
      needsCodeReference: true
    }
  }
}

export const createBuildAssetPlugin = (
  publicBase: string,
  assetsDir: string,
  inlineLimit: number
): Plugin => {
  const assets = new Map()
  return {
    name: 'mvt:asset',
    async load(id) {
      if (isStaticAsset(id)) {
        const { fileName, content, url } = await resolveAsset(
          id,
          publicBase,
          assetsDir,
          inlineLimit
        )
        assets.set(fileName, content)
        debug(`${id} -> ${url.startsWith('data:') ? `base64 inlined` : url}`)
        return `export default ${JSON.stringify(url)}`
      }
    },

    generateBundle(_options, bundle) {
      registerAssets(assets, bundle)
    }
  }
}
