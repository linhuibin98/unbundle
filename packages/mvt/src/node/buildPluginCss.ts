import path from 'pathe'
import { getAssetPublicPath, registerAssets } from './buildPluginAsset'
import { loadPostcssConfig } from './config'
import { isExternalUrl } from './utils'

import type { Plugin } from 'rollup'

const debug = require('debug')('mvt:css')

const urlRE = /(url\(\s*['"]?)([^"')]+)(["']?\s*\))/

export const createBuildCssPlugin = (
  root: string,
  assetsDir: string,
  cssFileName: string,
  minify: boolean
): Plugin => {
  const styles: Map<string, string> = new Map()
  const assets = new Map()

  return {
    name: 'mvt:css',
    async transform(css, id) {
      if (id.endsWith('.css')) {
        // process url() - register referenced files as assets
        // and rewrite the url to the resolved public path
        if (urlRE.test(css)) {
          const fileDir = path.dirname(id)
          urlRE.lastIndex = 0
          let match
          let remaining = css
          let rewritten = ''
          while ((match = urlRE.exec(remaining))) {
            rewritten += remaining.slice(0, match.index)
            const [matched, before, rawUrl, after] = match
            if (isExternalUrl(rawUrl)) {
              rewritten += matched
              remaining = remaining.slice(match.index + matched.length)
              return
            }
            const file = path.join(fileDir, rawUrl)
            const { fileName, content, url } = await getAssetPublicPath(
              file,
              assetsDir
            )
            assets.set(fileName, content)
            debug(`url(${rawUrl}) -> url(${url})`)
            rewritten += `${before}${url}${after}`
            remaining = remaining.slice(match.index + matched.length)
          }
          css = rewritten + remaining
        }

        // postcss
        let modules
        const postcssConfig = await loadPostcssConfig(root)
        const expectsModule = id.endsWith('.module.css')
        if (postcssConfig || expectsModule) {
          try {
            const result = await require('postcss')([
              ...(postcssConfig && postcssConfig.plugins || []),
              ...(expectsModule ? [
                require('postcss-modules')({
                  getJSON(_: string, json: Record<string, string>) {
                    modules = json
                  }
                })
              ] : [])
            ]).process(css, {
              ...(postcssConfig && postcssConfig.options),
              from: id
            })
            css = result.css
          } catch (e) {
            console.error(`[mvt] error applying postcss transforms: `, e)
          }
        }

        styles.set(id, css)
        return modules ? `export default ${JSON.stringify(modules)}` : '/* css extracted by mvt */'
      }
    },

    async generateBundle(_options, bundle) {
      let css = ''
      // finalize extracted css
      styles.forEach((s) => {
        css += s
      })
      // minify with cssnano
      if (minify) {
        css = (
          await require('postcss')([require('cssnano')]).process(css, {
            from: undefined
          })
        ).css
      }

      bundle[cssFileName] = {
        type: 'asset',
        fileName: cssFileName,
        name: cssFileName,
        source: css,
        needsCodeReference: true
      }

      registerAssets(assets, bundle)
    }
  }
}
