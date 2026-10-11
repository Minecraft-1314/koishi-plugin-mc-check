import { Context, Schema, h } from 'koishi'
import fs from 'node:fs'
import path from 'node:path'
import { renderStatusCard } from './card'
import { registerCommand } from './command'
import { sendUpdatePush, setupUpdatePush, UPDATE_PUSH_PREFIX } from './push'
import type { ServerAssets, ServerStatus, ServerTarget, VersionInfo } from './types'
import { formatStatus, parseHostPort, parseTime, tcpPing } from './utils'

export const name = 'mc-check'
export const inject = { optional: ['database', 'puppeteer', 'http'] }

interface McCheckConfig {
  debug: boolean
  globalServers: string[]
  globalServerType: 'java' | 'bedrock'
  requestTimeout: number
  enableAutoUpdatePush: boolean
  autoUpdateTime: string
  enableBedrockFallback: boolean
  enableCardImage: boolean
  messages: {
    mcCheckNoGlobal: string
    mcCheckTimeout: string
    mcUpdateNoUpdate: string
    mcUpdateRelease: string
    mcUpdateSnapshot: string
    mcUpdateError: string
    skinNotFound: string
    skinTitle: string
    databaseRequired: string
    puppeteerRequired: string
    mcCheckInvalidType: string
  }
}

interface McVersionCache {
  id: number
  releaseId: string
  snapshotId: string
  updatedAt: Date
}

declare module 'koishi' {
  interface Tables {
    mc_version_cache: McVersionCache
  }
}

const timePattern = /^([01]?\d|2[0-3]):([0-5]\d)$/
const uuidPattern = /^[0-9a-f]{32}$/i

export const Config: Schema<McCheckConfig> = Schema.object({
  debug: Schema.boolean().description('开启调试日志（输出全部请求与响应数据）').default(false),
  globalServers: Schema.array(Schema.string().role('url')).description('全局默认服务器地址列表').default([]),
  globalServerType: Schema.union(['java', 'bedrock']).description('全局默认服务器类型').default('java'),
  requestTimeout: Schema.number().description('API 请求超时（毫秒）').default(5000).min(1000).max(15000).step(1000),
  enableAutoUpdatePush: Schema.boolean().description('开启版本更新自动推送').default(false),
  autoUpdateTime: Schema.string().description('版本更新推送时间（HH:mm）').default('09:00').pattern(timePattern),
  enableBedrockFallback: Schema.boolean().description('Java 服务器离线时自动尝试 Bedrock 查询').default(true),
  enableCardImage: Schema.boolean().description('查询单个服务器时自动生成精美卡片图片（需 Puppeteer）').default(false),
  messages: Schema.object({
    mcCheckNoGlobal: Schema.string().description('无全局服务器提示').default('未配置全局服务器'),
    mcCheckTimeout: Schema.string().description('查询超时提示').default('查询超时'),
    mcUpdateNoUpdate: Schema.string().description('无更新提示').default('当前已是最新版本，暂无更新。'),
    mcUpdateRelease: Schema.string().description('正式版更新标题').default('📦 Minecraft 正式版更新'),
    mcUpdateSnapshot: Schema.string().description('快照版更新标题').default('📦 Minecraft 快照版更新'),
    mcUpdateError: Schema.string().description('版本检查失败提示').default('获取版本信息失败'),
    skinNotFound: Schema.string().description('皮肤未找到提示').default('未找到该玩家'),
    skinTitle: Schema.string().description('皮肤标题').default('{0} 的皮肤'),
    databaseRequired: Schema.string().description('缺少数据库提示').default('本功能需要安装数据库插件（如 database-sqlite）。'),
    puppeteerRequired: Schema.string().description('缺少 Puppeteer 提示').default('需要安装并启用 puppeteer 服务才能使用此功能。'),
    mcCheckInvalidType: Schema.string().description('无效服务器类型提示').default('无效的服务器类型，仅支持 java 或 bedrock'),
  }).description('自定义回复文本'),
}).description('Minecraft 服务器状态插件')

export function apply(ctx: Context, config: McCheckConfig) {
  const logger = ctx.logger('mc-check')

  function debugLog(msg: string) {
    if (config.debug) logger.info(msg)
  }

  function getPuppeteer(): any {
    return (ctx as any).puppeteer || (ctx as any).get?.('puppeteer')
  }

  function getHttp(): any {
    return (ctx as any).http || (ctx as any).get?.('http')
  }

  function t(key: keyof McCheckConfig['messages'], ...args: any[]): string {
    let tmpl = config.messages?.[key] || key
    for (let i = 0; i < args.length; i++) {
      tmpl = tmpl.split(`{${i}}`).join(String(args[i]))
    }
    return tmpl
  }

  function getDatabase(): any {
    return (ctx as any).database || (ctx as any).get?.('database')
  }

  function errorMessage(error: any): string {
    return String(error?.message || error || '未知错误')
  }

  ctx.inject(['database'], (databaseCtx) => {
    try {
      databaseCtx.model.extend('mc_version_cache', {
        id: 'unsigned',
        releaseId: 'string',
        snapshotId: 'string',
        updatedAt: 'timestamp',
      }, { primary: 'id', autoInc: true })
    } catch (error) {
      logger.warn(`扩展版本缓存表失败：${errorMessage(error)}`)
    }
  })

  setupUpdatePush(ctx, logger, () => t('databaseRequired'))

  async function fetchServerStatus(host: string, type: 'java' | 'bedrock'): Promise<ServerStatus> {
    const defaultPort = type === 'bedrock' ? 19132 : 25565
    const { host: address, port } = parseHostPort(host, defaultPort)
    const query = port === defaultPort ? address : `${address}:${port}`
    const endpoint = type === 'bedrock'
      ? `https://api.mcsrvstat.us/bedrock/3/${encodeURIComponent(query)}`
      : `https://api.mcsrvstat.us/3/${encodeURIComponent(query)}`
    debugLog(`[mc-check] 请求服务器状态: ${endpoint}`)
    try {
      const http = getHttp()
      if (!http?.get) throw new Error('HTTP 服务不可用')
      const data = await http.get(endpoint, {
        timeout: config.requestTimeout,
        headers: { 'User-Agent': 'KoishiMCPlugin/2.0' },
      })
      const payload = data && typeof data === 'object' ? data : {}
      if (config.debug) {
        logger.info(`[mc-check] 响应数据:\n${JSON.stringify(payload, null, 2)}`)
      }
      const online = Boolean(payload.online)
      let ping: number | null = null
      if (online) {
        const pingHost = payload.hostname || payload.ip || address
        const pingPort = Number(payload.port) || port
        ping = await tcpPing(pingHost, pingPort)
      }
      const motdRaw = payload.motd && typeof payload.motd === 'object' ? payload.motd : {}
      const motd = Array.isArray(motdRaw.clean)
        ? motdRaw.clean.filter(Boolean).join(' | ')
        : (typeof motdRaw.clean === 'string' && motdRaw.clean)
          || (Array.isArray(motdRaw.raw) ? motdRaw.raw.filter(Boolean).join(' ') : '')
      const players = payload.players && typeof payload.players === 'object' ? payload.players : {}
      const list = Array.isArray(players.list) ? players.list : []
      return {
        online,
        host: address,
        port,
        version: typeof payload.version === 'string' ? payload.version : (payload.version?.name || '未知'),
        motd,
        players: {
          online: Number(players.online ?? 0) || 0,
          max: Number(players.max ?? 0) || 0,
          list,
        },
        ping,
        icon: typeof payload.icon === 'string' ? payload.icon : null,
        software: typeof payload.software === 'string' ? payload.software : (payload.software?.name || null),
        error: typeof payload.error === 'string' ? payload.error : null,
      }
    } catch (error: any) {
      debugLog(`[mc-check] 请求失败: ${errorMessage(error)}`)
      return {
        online: false,
        host: address,
        port,
        version: '',
        motd: '',
        players: { online: 0, max: 0, list: [] },
        ping: null,
        icon: null,
        software: null,
        error: errorMessage(error),
      }
    }
  }

  async function fetchWithFallback(host: string, type: 'java' | 'bedrock'): Promise<ServerStatus> {
    const result = await fetchServerStatus(host, type)
    if (!result.online && type === 'java' && config.enableBedrockFallback) {
      debugLog(`[mc-check] Java 离线，尝试 Bedrock 查询: ${host}`)
      return fetchServerStatus(host, 'bedrock')
    }
    return result
  }

  const uuidCache = new Map<string, { value: string | null; time: number }>()
  const UUID_TTL = 60 * 60 * 1000
  const UUID_MAX = 200

  async function fetchUuid(username: string): Promise<string | null> {
    const now = Date.now()
    const hit = uuidCache.get(username)
    if (hit && now - hit.time < UUID_TTL) return hit.value
    const url = `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(username)}`
    debugLog(`[mc-skin] 请求 UUID: ${url}`)
    try {
      const http = getHttp()
      if (!http?.get) throw new Error('HTTP 服务不可用')
      const data = await http.get(url, { timeout: 5000 })
      if (config.debug) logger.info(`[mc-skin] UUID 响应: ${JSON.stringify(data)}`)
      const rawValue = typeof data?.id === 'string' ? data.id : ''
      const value: string | null = uuidPattern.test(rawValue) ? rawValue : null
      if (uuidCache.size >= UUID_MAX) {
        const first = uuidCache.keys().next().value
        if (first) uuidCache.delete(first)
      }
      uuidCache.set(username, { value, time: now })
      return value
    } catch (error: any) {
      debugLog(`[mc-skin] UUID 请求失败: ${errorMessage(error)}`)
      return null
    }
  }

  async function fetchSkin(player: string): Promise<Buffer | null> {
    const uuid = await fetchUuid(player)
    if (!uuid) return null
    const url = `https://visage.surgeplay.com/full/512/${uuid}`
    try {
      const http = getHttp()
      if (!http?.get) throw new Error('HTTP 服务不可用')
      const buffer = await http.get(url, {
        responseType: 'arraybuffer',
        timeout: 10000,
        headers: {
          'User-Agent': 'KoishiMCPlugin/2.0 (+https://github.com/Minecraft-1314/koishi-plugin-mc-check)',
        },
      })
      return Buffer.from(buffer as ArrayBuffer)
    } catch (error: any) {
      debugLog(`[mc-skin] 皮肤下载失败: ${errorMessage(error)}`)
      return null
    }
  }

  async function fetchVersionInfo(): Promise<VersionInfo | null> {
    try {
      const http = getHttp()
      if (!http?.get) throw new Error('HTTP 服务不可用')
      const data = await http.get('https://piston-meta.mojang.com/mc/game/version_manifest.json', { timeout: 10000 })
      const { latest, versions } = data && typeof data === 'object' ? data : {}
      if (!latest || !Array.isArray(versions)) return null
      const release = versions.find((v: any) => v.id === latest.release)
      const snapshot = versions.find((v: any) => v.id === latest.snapshot)
      if (!release || !snapshot) return null
      return { release, snapshot }
    } catch (error: any) {
      debugLog(`[mc-update] 获取版本清单失败: ${errorMessage(error)}`)
      return null
    }
  }

  let memoryVersionCache = { releaseId: '', snapshotId: '' }

  async function readVersionCache(): Promise<{ releaseId: string; snapshotId: string }> {
    const database = getDatabase()
    if (!database) return memoryVersionCache
    try {
      const rows = await database.get('mc_version_cache', { id: 1 })
      if (rows.length) {
        memoryVersionCache = { releaseId: rows[0].releaseId, snapshotId: rows[0].snapshotId }
      }
    } catch (error: any) {
      debugLog(`[mc-update] 读取缓存失败: ${errorMessage(error)}`)
    }
    return memoryVersionCache
  }

  async function writeVersionCache(info: VersionInfo): Promise<void> {
    memoryVersionCache = { releaseId: info.release.id, snapshotId: info.snapshot.id }
    const database = getDatabase()
    if (!database) return
    try {
      await database.upsert('mc_version_cache', [{
        id: 1,
        releaseId: info.release.id,
        snapshotId: info.snapshot.id,
        updatedAt: new Date(),
      }])
    } catch (error: any) {
      debugLog(`[mc-update] 写入缓存失败: ${errorMessage(error)}`)
    }
  }

  async function refreshVersionCache(): Promise<VersionInfo | null> {
    const info = await fetchVersionInfo()
    if (info) await writeVersionCache(info)
    return info
  }

  const assets: ServerAssets = {}

  ctx.on('ready', async () => {
    if (getPuppeteer()) {
      const sourceDir = path.resolve(__dirname, '../source')
      const fontPath = path.resolve(sourceDir, '荆南麦圆体.otf')
      const bgPath = path.resolve(sourceDir, 'qzbknd.png')
      if (fs.existsSync(fontPath)) assets.fontPath = fontPath
      if (fs.existsSync(bgPath)) assets.bgPath = bgPath
    }
    try {
      const info = await refreshVersionCache()
      if (info && config.debug) {
        logger.info(`[mc-update] 启动时缓存版本: release=${info.release.id}, snapshot=${info.snapshot.id}`)
      }
    } catch (error: any) {
      debugLog(`[mc-update] 启动缓存失败: ${errorMessage(error)}`)
    }
  })

  function getGlobalServers(): ServerTarget[] {
    return (config.globalServers || [])
      .filter((address) => typeof address === 'string' && address.trim())
      .map((address) => ({ address: address.trim(), type: config.globalServerType }))
  }

  registerCommand(ctx, 'mc-check [address]', '查询 Minecraft 服务器状态', (command) => {
    command.option('type', '-t <type:string>')
      .action(async ({ options }, address?: string) => {
      debugLog(`[mc-check] 指令触发，参数: address=${address}, type=${options?.type}`)
      if (address) {
        let requestedType = config.globalServerType
        if (options?.type) {
          if (options.type === 'java' || options.type === 'bedrock') {
            requestedType = options.type
          } else {
            return t('mcCheckInvalidType')
          }
        }
        const status = await fetchWithFallback(address, requestedType)
        const statusText = formatStatus(status, address, t('mcCheckTimeout'))
        if (config.enableCardImage) {
          const puppeteer = getPuppeteer()
          if (!puppeteer) {
            return `${statusText}\n${t('puppeteerRequired')}`
          }
          const image = await renderStatusCard(puppeteer, status, address, assets)
          if (image) return h.image(image, 'image/jpeg')
        }
        return statusText
      }
      const targets = getGlobalServers()
      if (!targets.length) return t('mcCheckNoGlobal')
      debugLog(`[mc-check] 批量查询目标: ${JSON.stringify(targets.map((target) => target.address))}`)
      const CONCURRENCY = 5
      const results: string[] = []
      for (let i = 0; i < targets.length; i += CONCURRENCY) {
        const batch = targets.slice(i, i + CONCURRENCY)
        const batchResults = await Promise.all(batch.map(async (target) => {
          const status = await fetchWithFallback(target.address, target.type)
          return formatStatus(status, target.address, t('mcCheckTimeout'))
        }))
        results.push(...batchResults)
      }
      return results.join('\n\n')
      })
  })

  registerCommand(ctx, 'mc-skin <player>', '查看正版玩家皮肤', (command) => {
    command.action(async (_argv, player?: string) => {
      debugLog(`[mc-skin] 查询皮肤: ${player}`)
      if (!player) return t('skinNotFound')
      const buffer = await fetchSkin(player)
      if (!buffer) return t('skinNotFound')
      return [`${t('skinTitle', player)}\n`, h.image(buffer, 'image/png')]
      })
  })

  registerCommand(ctx, 'mc-update', '查看版本更新', (command) => {
    command.action(async () => {
      debugLog('[mc-update] 检查版本')
      try {
        const info = await fetchVersionInfo()
        if (!info) return t('mcUpdateError')
        const { release, snapshot } = info
        const cached = await readVersionCache() || { releaseId: '', snapshotId: '' }
        if (release.id === cached.releaseId && snapshot.id === cached.snapshotId) {
          return t('mcUpdateNoUpdate')
        }
        await writeVersionCache(info)
        const parts: string[] = []
        if (release.id !== cached.releaseId) {
          parts.push(`${t('mcUpdateRelease')}: ${release.id}`)
          parts.push(`  时间: ${new Date(release.releaseTime).toLocaleString('zh-CN')}`)
        }
        if (snapshot.id !== cached.snapshotId) {
          parts.push(`${t('mcUpdateSnapshot')}: ${snapshot.id}`)
          parts.push(`  时间: ${new Date(snapshot.releaseTime).toLocaleString('zh-CN')}`)
        }
        return parts.join('\n')
      } catch (error: any) {
        debugLog(`[mc-update] 检查版本失败: ${errorMessage(error)}`)
        return `${t('mcUpdateError')}（${errorMessage(error)}）`
      }
      })
  })

  async function pushVersionUpdate(): Promise<void> {
    debugLog('[auto-update] 定时检查版本')
    try {
      const info = await fetchVersionInfo()
      if (!info) return
      const { release, snapshot } = info
      const cached = await readVersionCache() || { releaseId: '', snapshotId: '' }
      if (release.id === cached.releaseId && snapshot.id === cached.snapshotId) return
      if (!cached.releaseId && !cached.snapshotId) {
        await writeVersionCache(info)
        return
      }
      const parts: string[] = []
      if (release.id !== cached.releaseId) parts.push(`🟢 正式版 ${release.id} 发布`)
      if (snapshot.id !== cached.snapshotId) parts.push(`🟠 快照版 ${snapshot.id} 发布`)
      const message = parts.length ? `${UPDATE_PUSH_PREFIX}\n${parts.join('\n')}` : ''
      if (!message) return
      const result = await sendUpdatePush(ctx, message)
      if (result.fail) return
      await writeVersionCache(info)
      logger.info(`我的世界更新推送完成：成功 ${result.success}，失败 ${result.fail}`)
    } catch (error: any) {
      debugLog(`[auto-update] 推送失败: ${errorMessage(error)}`)
    }
  }

  if (config.enableAutoUpdatePush) {
    const schedule = () => {
      const { hour, minute } = parseTime(config.autoUpdateTime)
      const now = new Date()
      const target = new Date(now)
      target.setHours(hour, minute, 0, 0)
      if (target <= now) target.setDate(target.getDate() + 1)
      ctx.setTimeout(async () => {
        try {
          await pushVersionUpdate()
        } finally {
          schedule()
        }
      }, target.getTime() - now.getTime())
    }
    try {
      schedule()
    } catch (error) {
      logger.warn(`启动版本更新定时任务失败：${errorMessage(error)}`)
    }
  }
}
