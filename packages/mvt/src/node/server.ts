import http, { Server } from 'http'
import Koa from 'koa'
import chokidar from 'chokidar'
import { createResolver } from './resolver'

import { hmrPlugin, HMRWatcher } from './serverPluginHmr'
import { moduleRewritePlugin } from './serverPluginModuleRewrite'
import { moduleResolvePlugin } from './serverPluginModuleResolve'
import { vuePlugin } from './serverPluginVue'
import { serveStaticPlugin } from './serverPluginServeStatic'
import { jsonPlugin } from './serverPluginJson'

import type { Resolver, InternalResolver } from './resolver'
import slash from 'slash'

export { Resolver }

export interface PluginContext {
  root: string
  app: Koa
  server: Server
  watcher: HMRWatcher
  resolver: InternalResolver
}

export type Plugin = (ctx: PluginContext) => void

export interface ServerConfig {
  root?: string
  plugins?: Plugin[]
  resolvers?: Resolver[]
}

const internalPlugins: Plugin[] = [
  moduleRewritePlugin,
  moduleResolvePlugin,
  vuePlugin,
  jsonPlugin,
  hmrPlugin,
  serveStaticPlugin
]

export function createServer(config: ServerConfig = {}): Server {
  const { plugins = [], resolvers = [] } = config
  let { root = process.cwd() } = config
  root = slash(root)
  const app = new Koa()
  const server = http.createServer(app.callback())
  const watcher = chokidar.watch(root, {
    ignored: [/node_modules/]
  }) as HMRWatcher
  const resolver = createResolver(root, resolvers)

  ;[...plugins, ...internalPlugins].forEach((m) =>
    m({
      root,
      app,
      server,
      watcher,
      resolver
    })
  )

  return server
}
