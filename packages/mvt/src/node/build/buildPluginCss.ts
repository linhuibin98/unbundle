import path from 'pathe'
import { resolveAsset, registerAssets } from './buildPluginAsset'
import { loadPostcssConfig } from '../utils/resolvePostCssConfig'
import { isExternalUrl, asyncReplace } from '../utils/index'

import type { Plugin } from 'rollup'

const debug = require('debug')('mvt:build:css')

const urlRE = /(url\(\s*['"]?)([^"')]+)(["']?\s*\))/

export const createBuildCssPlugin = (
  root: string,
  publicBase: string,
  assetsDir: string,
  cssFileName: string,
  minify: boolean,
  inlineLimit: number
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
          css = await asyncReplace(
            css,
            urlRE,
            async ([matched, before, rawUrl, after]) => {
              if (isExternalUrl(rawUrl) || rawUrl.startsWith('data:')) {
                return matched
              }
              const file = path.join(fileDir, rawUrl)
              const { fileName, content, url } = await resolveAsset(
                file,
                publicBase,
                assetsDir,
                inlineLimit
              )
              assets.set(fileName, content)
              debug(
                `url(${rawUrl}) -> ${
                  url.startsWith('data:') ? `base64 inlined` : `url(${url})`
                }`
              )
              return `${before}${url}${after}`
            }
          )
        }

        // postcss
        let modules
        const postcssConfig = await loadPostcssConfig(root)
        const expectsModule = id.endsWith('.module.css')
        if (postcssConfig || expectsModule) {
          try {
            const result = await require('postcss')([
              ...((postcssConfig && postcssConfig.plugins) || []),
              ...(expectsModule
                ? [
                    require('postcss-modules')({
                      getJSON(_: string, json: Record<string, string>) {
                        modules = json
                      }
                    })
                  ]
                : [])
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
        return {
          code: modules
            ? `export default ${JSON.stringify(modules)}`
            : '/* css extracted by mvt */',
          map: null
        }
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
