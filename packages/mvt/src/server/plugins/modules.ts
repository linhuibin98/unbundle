import { resolveVue } from '../resolveVue'
import path from 'pathe'
import { Readable } from 'stream'
import resolve from 'resolve-from'
import MagicString from 'magic-string'
// @ts-ignore
import { init as initLexer, parse as parseImports } from 'es-module-lexer'
import { cachedRead } from '../utils'
import { promises as fs } from 'fs'
import { hmrClientPublicPath } from './hmr'
import { parse } from '@babel/parser'
import { StringLiteral } from '@babel/types'

import type { Plugin } from '../index'

const idToFileMap = new Map()
const fileToIdMap = new Map()
const webModulesMap = new Map()

export const moduleResolverPlugin: Plugin = ({ root, app }) => {
  // rewrite named module imports to `/@modules/:id` requests
  app.use(async (ctx, next) => {
    await next()

    if (ctx.status === 304) {
      return
    }

    if (ctx.url === '/index.html') {
      const html = await readBody(ctx.body)
      await initLexer
      ctx.body = html.replace(
        /(<script\b[^>]*>)([\s\S]*?)<\/script>/gm,
        (_, openTag, script) => {
          return `${openTag}${rewriteImports(script, '/index.html')}</script>`
        }
      )
    }

    // we are doing the js rewrite after all other middlewares have finished;
    // this allows us to post-process javascript produced by user middlewares
    // regardless of the extension of the original files.
    if (
      ctx.response.is('js') &&
      // skip special requests (internal scripts & module redirects)
      !ctx.path.startsWith(`/@`) &&
      // only need to rewrite for <script> part in vue files
      !(ctx.path.endsWith('.vue') && ctx.query.type != null)
    ) {
      await initLexer
      ctx.body = rewriteImports(
        await readBody(ctx.body),
        ctx.url.replace(/(&|\?)t=\d+/, ''),
        ctx.query.t as string
      )
    }
  })

  // handle /@modules/:id requests
  const moduleRE = /^\/@modules\//
  app.use(async (ctx, next) => {
    if (!moduleRE.test(ctx.path)) {
      return next()
    }

    const id = ctx.path.replace(moduleRE, '')
    ctx.type = 'js'

    // special handling for vue's runtime.
    if (id === 'vue') {
      ctx.body = await cachedRead(resolveVue(root).vue)
      return
    }

    // already resolved and cached
    const cachedPath = idToFileMap.get(id)
    if (cachedPath) {
      ctx.body = await cachedRead(cachedPath)
      return
    }
    // source map request
    if (id.endsWith('.map')) {
      // try to reverse-infer the original file that made the sourcemap request.
      // assumes the `.js` and `.js.map` files to have the same prefix.
      const sourceMapRequest = id
      const jsRequest = sourceMapRequest.replace(/\.map$/, '')
      const moduleId = fileToIdMap.get(jsRequest)
      if (!moduleId) {
        console.error(
          `[mvt] failed to infer original js file for source map request ` +
            sourceMapRequest
        )
        ctx.status = 404
        return
      } else {
        const modulePath = idToFileMap.get(moduleId)
        const sourceMapPath = path.join(
          path.dirname(modulePath),
          sourceMapRequest
        )
        idToFileMap.set(sourceMapRequest, sourceMapPath)
        ctx.type = 'application/json'
        ctx.body = await cachedRead(sourceMapPath)
        return
      }
    }

    // resolve from web_modules
    try {
      const webModulePath = await resolveWebModule(root, id)
      if (webModulePath) {
        idToFileMap.set(id, webModulePath)
        fileToIdMap.set(path.basename(webModulePath), id)
        ctx.body = await cachedRead(webModulePath)
        return
      }
    } catch (e) {
      console.error(e)
      ctx.status = 404
    }

    // resolve from node_modules
    try {
      // get the module name in case of deep imports like 'foo/dist/bar.js'
      let moduleName = id
      const deepIndex = id.indexOf('/')
      if (deepIndex > 0) {
        moduleName = id.slice(0, deepIndex)
      }
      const pkgPath = resolve(root, `${moduleName}/package.json`)
      const pkg = require(pkgPath)
      const moduleRelativePath =
        deepIndex > 0
          ? id.slice(deepIndex + 1)
          : pkg.module || pkg.main || 'index.js'
      const modulePath = path.join(path.dirname(pkgPath), moduleRelativePath)
      idToFileMap.set(id, modulePath)
      fileToIdMap.set(path.basename(modulePath), id)
      ctx.body = await cachedRead(modulePath)
    } catch (e) {
      console.error(e)
      ctx.status = 404
    }
  })
}

async function readBody(stream: Readable | string): Promise<string> {
  if (stream instanceof Readable) {
    return new Promise((resolve, reject) => {
      let res = ''
      stream
        .on('data', (chunk) => (res += chunk))
        .on('error', reject)
        .on('end', () => {
          resolve(res)
        })
    })
  } else {
    return stream
  }
}

async function resolveWebModule(
  root: string,
  id: string
): Promise<string | undefined> {
  const webModulePath = webModulesMap.get(id)
  if (webModulePath) {
    return webModulePath
  }
  const importMapPath = path.join(root, 'web_modules', 'import-map.json')
  if (await fs.stat(importMapPath).catch((e) => false)) {
    const importMap = require(importMapPath)
    if (importMap.imports) {
      const webModulesDir = path.dirname(importMapPath)
      Object.entries(importMap.imports).forEach(
        ([key, val]: [string, string]) =>
          webModulesMap.set(key, path.join(webModulesDir, val))
      )
      return webModulesMap.get(id)
    }
  }
}

// while we lex the files for imports we also build a import graph
// so that we can determine what files to hot reload
type HMRStateMap = Map<string, Set<string>>

export const importerMap: HMRStateMap = new Map() // 模块被什么模块依赖
export const importeeMap: HMRStateMap = new Map() // 模块依赖的模块
export const hmrBoundariesMap: HMRStateMap = new Map()

const ensureMapEntry = (map: HMRStateMap, key: string): Set<string> => {
  let entry = map.get(key)
  if (!entry) {
    entry = new Set<string>()
    map.set(key, entry)
  }
  return entry
}

function rewriteImports(source: string, importer: string, timestamp?: string) {
  try {
    const [imports] = parseImports(source)
    if (imports.length) {
      const s = new MagicString(source)
      let hasReplaced = false

      const prevImportees = importeeMap.get(importer)
      const currentImportees = new Set<string>()
      importeeMap.set(importer, currentImportees)

      imports.forEach(({ s: start, e: end, d: dynamicIndex }) => {
        const id = source.substring(start, end)
        if (dynamicIndex === -1) {
          if (/^[^\/\.]/.test(id)) {
            s.overwrite(start, end, `/@modules/${id}`)
            hasReplaced = true
          } else if (id === hmrClientPublicPath) {
            if (!/.vue$|.vue\?type=/.test(importer)) {
              // the user explicit imports the HMR API in a js file
              // making the module hot.
              parseAcceptedDeps(source, importer, s)
              // we rewrite the hot.accept call
              hasReplaced = true
            }
          } else {
            // force re-fetch all imports by appending timestamp
            // if this is a hmr refresh request
            if (timestamp) {
              s.overwrite(
                start,
                end,
                `${id}${/\?/.test(id) ? `&` : `?`}t=${timestamp}`
              )
              hasReplaced = true
            }
            // save the import chain for hmr analysis
            const importee = path.join(path.dirname(importer), id)
            currentImportees.add(importee)
            ensureMapEntry(importerMap, importee).add(importer)
          }
        } else if (dynamicIndex >= 0) {
          // TODO dynamic import
        }
      })

      // since the importees may have changed due to edits,
      // check if we need to remove this importer from certain importees
      if (prevImportees) {
        prevImportees.forEach((importee) => {
          if (!currentImportees.has(importee)) {
            const importers = importerMap.get(importee)
            if (importers) {
              importers.delete(importer)
            }
          }
        })
      }

      return hasReplaced ? s.toString() : source
    }

    return source
  } catch (e) {
    console.error(
      `[mvt] Error: module imports rewrite failed for ${importer}.`,
      e
    )
    return source
  }
}

function parseAcceptedDeps(source: string, importer: string, s: MagicString) {
  const ast = parse(source, {
    sourceType: 'module',
    plugins: [
      // by default we enable proposals slated for ES2020.
      // full list at https://babeljs.io/docs/en/next/babel-parser#plugins
      // this should be kept in async with @vue/compiler-core's support range
      'bigInt',
      'optionalChaining',
      'nullishCoalescingOperator'
    ]
  }).program.body

  const registerDep = (e: StringLiteral) => {
    const deps = ensureMapEntry(hmrBoundariesMap, importer)
    const depPublicPath = path.join(path.dirname(importer), e.value)
    deps.add(depPublicPath)
    s.overwrite(e.start!, e.end!, JSON.stringify(depPublicPath))
  }

  ast.forEach((node) => {
    if (
      node.type === 'ExpressionStatement' &&
      node.expression.type === 'CallExpression' &&
      node.expression.callee.type === 'MemberExpression' &&
      node.expression.callee.object.type === 'Identifier' &&
      node.expression.callee.object.name === 'hot' &&
      node.expression.callee.property.type === 'Identifier' &&
      node.expression.callee.property.name === 'accept'
    ) {
      const args = node.expression.arguments
      // inject the imports's own path so it becomes
      // hot.accept('/foo.js', ['./bar.js'], () => {})
      s.appendLeft(args[0].start!, JSON.stringify(importer) + ', ')
      // register the accepted deps
      if (args[0].type === 'ArrayExpression') {
        args[0].elements.forEach((e) => {
          if (e && e.type !== 'StringLiteral') {
            console.error(
              `[mvt] HMR syntax error in ${importer}: hot.accept() deps list can only contain string literals.`
            )
          } else if (e) {
            registerDep(e)
          }
        })
      } else if (args[0].type === 'StringLiteral') {
        registerDep(args[0])
      } else {
        console.error(
          `[mvt] HMR syntax error in ${importer}: hot.accept() expects a dep string or an array of deps.`
        )
      }
    }
  })
}
