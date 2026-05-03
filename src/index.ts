import { Context, Schema, h } from 'koishi'
import axios from 'axios'
import path from 'node:path'
import fs from 'node:fs'
import net from 'node:net'

export const inject = {
  required: ['database'],
  optional: ['puppeteer'],
}

interface McCheckConfig {
  debug: boolean
  globalServers: string[]
  globalServerType: 'java' | 'bedrock'
  enableGroupIsolation: boolean
  requestTimeout: number
  enableAutoUpdatePush: boolean
  autoUpdateTime: string
  enableBedrockFallback: boolean
  enableCardImage: boolean
  messages: {
    mcCheckNoServer: string
    mcCheckNoGlobal: string
    mcCheckTimeout: string
    mcBindSuccess: string
    mcBindGroupOnly: string
    mcBindDisabled: string
    mcBindDuplicate: string
    mcBindMissing: string
    mcUnbindSuccess: string
    mcUnbindSuccessOne: string
    mcUnbindNoBind: string
    mcUnbindGroupOnly: string
    mcUnbindDisabled: string
    mcUpdateNoUpdate: string
    mcUpdateRelease: string
    mcUpdateSnapshot: string
    mcUpdateError: string
    pinSuccess: string
    unpinSuccess: string
    globalSetAdd: string
    globalSetRemove: string
    globalSetList: string
    skinNotFound: string
    skinTitle: string
    databaseRequired: string
    puppeteerRequired: string
  }
}

interface McGuildServer {
  id: number
  guildId: string
  serverAddress: string
  serverType: 'java' | 'bedrock'
  pinned: boolean
  createdAt: Date
}

interface McVersionCache {
  id: number
  releaseId: string
  snapshotId: string
  updatedAt: Date
}

interface McGGlobalServer {
  id: number
  address: string
  type: 'java' | 'bedrock'
}

declare module 'koishi' {
  interface Tables {
    mc_guild_servers: McGuildServer
    mc_version_cache: McVersionCache
    mc_global_servers: McGGlobalServer
  }
}

function parseHostPort(raw: string, defaultPort: number): { host: string; port: number } {
  const match = raw.match(/^(.+?):(\d{1,5})$/)
  if (match) return { host: match[1], port: parseInt(match[2], 10) }
  return { host: raw, port: defaultPort }
}

function parseTime(timeStr: string): { hour: number; minute: number } {
  const [h, m] = timeStr.split(':').map(Number)
  return { hour: h, minute: m }
}

const timePattern = /^([01]?\d|2[0-4]):([0-5]\d)$/

function tcpPing(host: string, port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const start = Date.now()
    const socket = new net.Socket()
    socket.setTimeout(3000)
    socket.on('connect', () => {
      const ping = Date.now() - start
      socket.destroy()
      resolve(ping)
    })
    socket.on('error', () => {
      socket.destroy()
      resolve(null)
    })
    socket.on('timeout', () => {
      socket.destroy()
      resolve(null)
    })
    socket.connect(port, host)
  })
}

export const Config: Schema<McCheckConfig> = Schema.object({
  debug: Schema.boolean().description('开启调试日志（输出全部请求与响应数据）').default(false),
  globalServers: Schema.array(Schema.string().role('url')).description('全局默认服务器地址列表').default([]),
  globalServerType: Schema.union(['java', 'bedrock']).description('全局默认服务器类型').default('java'),
  enableGroupIsolation: Schema.boolean().description('启用后各群可单独绑定服务器').default(true),
  requestTimeout: Schema.number().description('API 请求超时（毫秒）').default(5000).min(1000).max(15000).step(1000),
  enableAutoUpdatePush: Schema.boolean().description('开启版本更新自动推送').default(false),
  autoUpdateTime: Schema.string().description('版本更新推送时间（HH:mm）').default('09:00').pattern(timePattern),
  enableBedrockFallback: Schema.boolean().description('Java 服务器离线时自动尝试 Bedrock 查询').default(true),
  enableCardImage: Schema.boolean().description('查询单个服务器时自动生成精美卡片图片（需 Puppeteer）').default(false),
  messages: Schema.object({
    mcCheckNoServer: Schema.string().description('无服务器提示').default('请提供服务器地址，或使用 mc-bind 绑定'),
    mcCheckNoGlobal: Schema.string().description('无全局服务器提示').default('未配置全局服务器'),
    mcCheckTimeout: Schema.string().description('查询超时提示').default('查询超时'),
    mcBindSuccess: Schema.string().description('绑定成功（{0} 为地址）').default('已绑定: {0}'),
    mcBindGroupOnly: Schema.string().description('仅群聊可用提示').default('该指令仅群聊可用'),
    mcBindDisabled: Schema.string().description('分群功能关闭提示').default('分群功能已关闭'),
    mcBindDuplicate: Schema.string().description('重复绑定提示').default('该服务器已绑定'),
    mcBindMissing: Schema.string().description('缺少地址提示').default('请提供服务器地址，例如 mc-bind play.example.com'),
    mcUnbindSuccess: Schema.string().description('解绑全部成功').default('已解绑全部服务器'),
    mcUnbindSuccessOne: Schema.string().description('解绑指定成功（{0} 为地址）').default('已解绑: {0}'),
    mcUnbindNoBind: Schema.string().description('未找到绑定提示').default('当前群未绑定该服务器'),
    mcUnbindGroupOnly: Schema.string().description('解绑仅群聊提示').default('该指令仅群聊可用'),
    mcUnbindDisabled: Schema.string().description('解绑分群关闭提示').default('分群功能已关闭'),
    mcUpdateNoUpdate: Schema.string().description('无更新提示').default('当前已是最新版本，暂无更新。'),
    mcUpdateRelease: Schema.string().description('正式版更新标题').default('📦 Minecraft 正式版更新'),
    mcUpdateSnapshot: Schema.string().description('快照版更新标题').default('📦 Minecraft 快照版更新'),
    mcUpdateError: Schema.string().description('版本检查失败提示').default('获取版本信息失败'),
    pinSuccess: Schema.string().description('置顶成功').default('已置顶: {0}'),
    unpinSuccess: Schema.string().description('取消置顶成功').default('已取消置顶: {0}'),
    globalSetAdd: Schema.string().description('添加全局服务器成功').default('已添加全局服务器: {0}'),
    globalSetRemove: Schema.string().description('移除全局服务器成功').default('已移除全局服务器: {0}'),
    globalSetList: Schema.string().description('全局服务器列表').default('当前全局服务器列表:\n{0}'),
    skinNotFound: Schema.string().description('皮肤未找到提示').default('未找到该玩家'),
    skinTitle: Schema.string().description('皮肤标题').default('{0} 的皮肤'),
    databaseRequired: Schema.string().description('缺少数据库提示').default('本功能需要安装数据库插件（如 database-sqlite）。'),
    puppeteerRequired: Schema.string().description('缺少 Puppeteer 提示').default('需要安装并启用 puppeteer 服务才能使用此功能。'),
  }).description('自定义回复文本'),
}).description('Minecraft 服务器状态插件')

async function toBase64(filePath: string): Promise<string> {
  try {
    const buffer = await fs.promises.readFile(filePath)
    const ext = path.extname(filePath).toLowerCase()
    let mime = 'application/octet-stream'
    if (ext === '.png') mime = 'image/png'
    else if (ext === '.jpg' || ext === '.jpeg') mime = 'image/jpeg'
    else if (ext === '.otf') mime = 'font/otf'
    else if (ext === '.ttf') mime = 'font/ttf'
    return `data:${mime};base64,${buffer.toString('base64')}`
  } catch {
    return ''
  }
}

export function apply(ctx: Context, config: McCheckConfig) {
  const logger = ctx.logger('mc-check')
  const puppeteer = (ctx as any).puppeteer

  let fontBase64 = ''
  let bgBase64 = ''

  ctx.on('ready', async () => {
    if (puppeteer) {
      const pluginRoot = __dirname
      const sourceDir = path.resolve(pluginRoot, '../source')
      const fontPath = path.resolve(sourceDir, '荆南麦圆体.otf')
      const bgPath = path.resolve(sourceDir, 'qzbknd.png')
      if (fs.existsSync(fontPath)) fontBase64 = await toBase64(fontPath)
      if (fs.existsSync(bgPath)) bgBase64 = await toBase64(bgPath)
    }
    try {
      const response = await axios.get('https://piston-meta.mojang.com/mc/game/version_manifest.json', { timeout: 10000 })
      const { latest, versions } = response.data
      if (latest && versions) {
        const release = versions.find((v: any) => v.id === latest.release)
        const snapshot = versions.find((v: any) => v.id === latest.snapshot)
        if (release && snapshot) {
          const existing = await ctx.database.get('mc_version_cache', {})
          if (existing.length) {
            await ctx.database.set('mc_version_cache', { id: existing[0].id }, {
              releaseId: release.id,
              snapshotId: snapshot.id,
              updatedAt: new Date(),
            })
          } else {
            await ctx.database.create('mc_version_cache', {
              releaseId: release.id,
              snapshotId: snapshot.id,
            })
          }
          if (config.debug) logger.info(`[mc-update] 启动时缓存版本: release=${release.id}, snapshot=${snapshot.id}`)
        }
      }
    } catch (e: any) {
      if (config.debug) logger.info(`[mc-update] 启动获取版本失败: ${e.message}`)
    }
  })

  function debugLog(msg: string) {
    if (config.debug) logger.info(msg)
  }

  ctx.i18n.define('zh', {
    commands: {
      'mc-check': { description: '查询服务器状态' },
      'mc-bind': { description: '绑定服务器' },
      'mc-unbind': { description: '解绑服务器' },
      'mc-update': { description: '查看版本更新' },
      'mc-pin': { description: '置顶服务器' },
      'mc-unpin': { description: '取消置顶' },
      'mc-global-set': { description: '管理全局服务器（管理员）' },
      'mc-skin': { description: '查看正版玩家皮肤' },
    },
  })

  function t(key: keyof McCheckConfig['messages'], ...args: any[]): string {
    let tmpl = config.messages[key] || key
    args.forEach((a, i) => (tmpl = tmpl.replace(`{${i}}`, a)))
    return tmpl
  }

  ctx.model.extend('mc_guild_servers', {
    id: 'unsigned',
    guildId: 'string',
    serverAddress: 'string',
    serverType: 'string',
    pinned: { type: 'boolean', initial: false },
    createdAt: 'timestamp',
  }, {
    primary: 'id',
    autoInc: true,
    unique: [['guildId', 'serverAddress']],
  })

  ctx.model.extend('mc_global_servers', {
    id: 'unsigned',
    address: 'string',
    type: 'string',
  }, { primary: 'id', autoInc: true })

  ctx.model.extend('mc_version_cache', {
    id: 'unsigned',
    releaseId: 'string',
    snapshotId: 'string',
    updatedAt: 'timestamp',
  }, { primary: 'id', autoInc: true })

  async function fetchServerStatus(host: string, type: 'java' | 'bedrock'): Promise<any> {
    const defaultPort = type === 'bedrock' ? 19132 : 25565
    const { host: h, port } = parseHostPort(host, defaultPort)
    const query = port === defaultPort ? h : `${h}:${port}`
    const endpoint = type === 'bedrock'
      ? `https://api.mcsrvstat.us/bedrock/3/${encodeURIComponent(query)}`
      : `https://api.mcsrvstat.us/3/${encodeURIComponent(query)}`
    debugLog(`[mc-check] 请求服务器状态: ${endpoint}`)
    try {
      const { data } = await axios.get(endpoint, {
        timeout: config.requestTimeout,
        headers: { 'User-Agent': 'KoishiMCPlugin/2.0' },
      })
      if (config.debug) {
        logger.info(`[mc-check] 响应数据:\n${JSON.stringify(data, null, 2)}`)
      }
      let latency: number | null = null
      if (data.online) {
        const targetHost = data.hostname || data.ip || h
        const targetPort = data.port || port || 25565
        latency = await tcpPing(targetHost, targetPort)
      }
      return {
        online: data.online,
        host: h,
        port: port,
        version: { name_raw: data.version || '未知' },
        motd: { clean: data.motd?.clean || [data.motd?.raw?.join(' ') || ''] },
        players: {
          online: data.players?.online ?? 0,
          max: data.players?.max ?? 0,
          list: data.players?.list || [],
        },
        ping: latency,
        icon: data.icon || null,
        software: data.software || null,
        plugins: data.plugins || [],
        mods: data.mods || [],
        error: null,
      }
    } catch (e: any) {
      debugLog(`[mc-check] 请求失败: ${e.message}`)
      return { online: false, error: e.message }
    }
  }

  async function fetchWithFallback(host: string, type: 'java' | 'bedrock'): Promise<any> {
    const result = await fetchServerStatus(host, type)
    if (!result.online && type === 'java' && config.enableBedrockFallback) {
      debugLog(`[mc-check] Java 离线，尝试 Bedrock 查询: ${host}`)
      return fetchServerStatus(host, 'bedrock')
    }
    return result
  }

  async function formatStatus(status: any, label: string): Promise<string> {
    if (!status.online) return `❌ ${label} - 离线${status.error ? ` (${status.error})` : ''}`

    const motd = status.motd?.clean?.join(' | ') || status.motd?.clean || ''
    const players = status.players
    const playerStr = players ? `${players.online}/${players.max}` : '?/?'
    const playerList = players?.online && players.list?.length
      ? `\n  在线: ${players.list.map((p: any) => p.name || p.name_clean || '未知玩家').join(', ')}`
      : ''
    const pingStr = status.ping !== null ? `  📶 ${status.ping}ms` : ''
    const software = status.software ? `\n⚙️ 服务端: ${status.software}` : ''

    return [
      `🟢 ${label}:${status.port || 25565}${pingStr}`,
      `📋 版本: ${status.version?.name_raw || status.version || '未知'}`,
      `👥 玩家: ${playerStr}${playerList}`,
      motd ? `💬 MOTD: ${motd}` : '',
      software,
    ].filter(Boolean).join('\n')
  }

  async function fetchUuid(username: string): Promise<string | null> {
    const url = `https://api.mojang.com/users/profiles/minecraft/${username}`
    debugLog(`[mc-skin] 请求 UUID: ${url}`)
    try {
      const { data } = await axios.get(url, { timeout: 5000 })
      if (config.debug) logger.info(`[mc-skin] UUID 响应: ${JSON.stringify(data)}`)
      return data?.id || null
    } catch (e: any) {
      debugLog(`[mc-skin] UUID 请求失败: ${e.message}`)
      return null
    }
  }

  async function fetchSkin(player: string): Promise<Buffer | null> {
    const uuid = await fetchUuid(player)
    if (!uuid) return null
    const url = `https://visage.surgeplay.com/full/512/${uuid}`
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 10000,
        headers: {
          'User-Agent': 'KoishiMCPlugin/2.0 (+https://github.com/Minecraft-1314/koishi-plugin-mc-check)'
        }
      })
      return Buffer.from(response.data)
    } catch (e: any) {
      debugLog(`[mc-skin] 皮肤下载失败: ${e.message}`)
      return null
    }
  }

  async function getGlobalServers(): Promise<Array<{ address: string; type: 'java' | 'bedrock' }>> {
    const dynamic = await ctx.database.get('mc_global_servers', {})
    if (dynamic.length) return dynamic.map(d => ({ address: d.address, type: d.type as 'java' | 'bedrock' }))
    return config.globalServers.map(s => ({ address: s, type: config.globalServerType }))
  }

  async function getTargets(guildId?: string): Promise<Array<{ address: string; type: 'java' | 'bedrock'; pinned?: boolean }>> {
    if (config.enableGroupIsolation && guildId) {
      const servers = await ctx.database.get('mc_guild_servers', { guildId })
      if (servers.length) {
        return servers
          .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
          .map(s => ({ address: s.serverAddress, type: s.serverType, pinned: s.pinned }))
      }
    }
    return (await getGlobalServers()).map(s => ({ address: s.address, type: s.type }))
  }

  async function renderStatusCard(status: any, label: string): Promise<Buffer | null> {
    if (!puppeteer) return null
    const online = status.online
    const hostDisplay = label
    const version = status.version?.name_raw || status.version || '未知'
    const players = status.players
    const playerOnline = players?.online ?? 0
    const playerMax = players?.max ?? 0
    const motdText = status.motd?.clean?.join(' | ') || status.motd?.clean || ''
    const ping = status.ping !== null ? status.ping : 0
    const software = status.software || ''
    const icon = status.icon
    const iconHtml = icon ? `<img src="${icon}" style="width:64px;height:64px;border-radius:8px;margin-right:16px;">` : ''
    const onlineColor = online ? '#4CAF50' : '#F44336'

    const fontFace = fontBase64 ? `@font-face { font-family: 'MinecraftFont'; src: url('${fontBase64}'); }` : ''
    const fontFamily = fontBase64 ? "'MinecraftFont', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif" : "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif"
    const bgStyle = bgBase64 ? `background-image: url('${bgBase64}'); background-size: cover; background-position: center;` : 'background: #1e1e1e;'

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${fontFace}body{margin:0;padding:30px;font-family:${fontFamily};${bgStyle}color:white;display:flex;justify-content:center;align-items:center;min-height:100vh;}.card{background:rgba(30,30,30,0.85);border-radius:20px;padding:30px;box-shadow:0 10px 30px rgba(0,0,0,0.5);width:500px;border:1px solid #444;}.header{display:flex;align-items:center;margin-bottom:20px;}.info{flex:1;}.hostname{font-size:28px;font-weight:bold;margin-bottom:5px;}.version{font-size:18px;color:#aaa;}.status{font-size:20px;font-weight:bold;color:${onlineColor};text-align:right;}.players{background:#444;border-radius:10px;padding:15px;margin:15px 0;display:flex;justify-content:space-between;font-size:22px;}.motd{background:#333;border-radius:10px;padding:15px;margin:15px 0;font-size:18px;line-height:1.5;color:#ddd;}.details{display:flex;gap:20px;font-size:16px;color:#aaa;}.ping{color:#8BC34A;font-weight:bold;}</style></head><body><div class="card"><div class="header">${iconHtml}<div class="info"><div class="hostname">${hostDisplay}</div><div class="version">版本: ${version}</div></div><div class="status">${online ? '在线' : '离线'}</div></div><div class="players"><span>👥 ${playerOnline}/${playerMax}</span><span>🟢 在线率 ${playerMax > 0 ? Math.round((playerOnline/playerMax)*100) : 0}%</span></div>${motdText ? `<div class="motd">${motdText}</div>` : ''}<div class="details">${software ? `<span>⚙️ ${software}</span>` : ''}${ping ? `<span class="ping">📶 ${ping}ms</span>` : ''}</div></div></body></html>`

    try {
      const page = await puppeteer.page()
      await page.setViewport({ width: 600, height: 400, deviceScaleFactor: 1 })
      await page.setContent(html)
      await page.waitForNetworkIdle({ idleTime: 500 })
      const image = await page.screenshot({ type: 'jpeg', quality: 90, fullPage: true })
      await page.close()
      return image as Buffer
    } catch {
      return null
    }
  }

  ctx.command('mc-check [address:text]', '查询服务器状态')
    .option('type', '-t <type:string>', { fallback: 'java' })
    .action(async ({ session, options }, address) => {
      debugLog(`[mc-check] 指令触发，参数: address=${address}, type=${options?.type}`)
      if (!address) {
        const targets = await getTargets(session?.guildId)
        if (!targets.length) return t('mcCheckNoServer')
        debugLog(`[mc-check] 批量查询目标: ${JSON.stringify(targets.map(t => t.address))}`)
        const results = await Promise.all(targets.map(async target => {
          const status = await fetchWithFallback(target.address, target.type)
          return formatStatus(status, target.address)
        }))
        return results.join('\n\n')
      }

      let target = address
      const type: 'java' | 'bedrock' = (options?.type === 'bedrock' ? 'bedrock' : config.globalServerType) as 'java' | 'bedrock'
      if (config.enableGroupIsolation && !address && session?.guildId) {
        const bound = await ctx.database.get('mc_guild_servers', { guildId: session.guildId })
        if (bound.length) target = bound[0].serverAddress
      }
      const status = await fetchWithFallback(target, type)
      if (config.enableCardImage && puppeteer) {
        const img = await renderStatusCard(status, target)
        if (img) return h.image(img, 'image/jpeg')
      }
      return formatStatus(status, target)
    })

  ctx.command('mc-bind <address:text>', '绑定服务器')
    .action(async ({ session }, address) => {
      debugLog(`[mc-bind] 绑定: ${address}`)
      if (!address) return t('mcBindMissing')
      if (!config.enableGroupIsolation) return t('mcBindDisabled')
      if (!session?.guildId) return t('mcBindGroupOnly')
      const exists = await ctx.database.get('mc_guild_servers', { guildId: session.guildId, serverAddress: address })
      if (exists.length) return t('mcBindDuplicate')
      await ctx.database.create('mc_guild_servers', {
        guildId: session.guildId,
        serverAddress: address,
        serverType: config.globalServerType,
      })
      return t('mcBindSuccess', address)
    })

  ctx.command('mc-unbind [address:text]', '解绑服务器')
    .action(async ({ session }, address) => {
      debugLog(`[mc-unbind] 解绑: ${address || '全部'}`)
      if (!config.enableGroupIsolation) return t('mcUnbindDisabled')
      if (!session?.guildId) return t('mcUnbindGroupOnly')
      if (address) {
        const removed = await ctx.database.remove('mc_guild_servers', { guildId: session.guildId, serverAddress: address })
        return removed ? t('mcUnbindSuccessOne', address) : t('mcUnbindNoBind')
      }
      await ctx.database.remove('mc_guild_servers', { guildId: session.guildId })
      return t('mcUnbindSuccess')
    })

  ctx.command('mc-pin <address:text>', '置顶服务器')
    .action(async ({ session }, address) => {
      debugLog(`[mc-pin] 置顶: ${address}`)
      if (!config.enableGroupIsolation) return t('mcBindDisabled')
      if (!session?.guildId) return t('mcBindGroupOnly')
      const updated = await ctx.database.set('mc_guild_servers', { guildId: session.guildId, serverAddress: address }, { pinned: true })
      return updated ? t('pinSuccess', address) : t('mcUnbindNoBind')
    })

  ctx.command('mc-unpin <address:text>', '取消置顶')
    .action(async ({ session }, address) => {
      debugLog(`[mc-unpin] 取消置顶: ${address}`)
      if (!config.enableGroupIsolation) return t('mcBindDisabled')
      if (!session?.guildId) return t('mcBindGroupOnly')
      const updated = await ctx.database.set('mc_guild_servers', { guildId: session.guildId, serverAddress: address }, { pinned: false })
      return updated ? t('unpinSuccess', address) : t('mcUnbindNoBind')
    })

  ctx.command('mc-global-set <action:text> [value:text]', '全局服务器管理（管理员）')
    .action(async ({ session }, action, value) => {
      debugLog(`[mc-global-set] 操作: ${action} ${value || ''}`)
      if (!session || ((session as any).authority ?? 0) < 2) return
      if (action === 'add' && value) {
        const type = session.content?.includes('-t bedrock') ? 'bedrock' : 'java'
        await ctx.database.create('mc_global_servers', { address: value, type })
        return t('globalSetAdd', value)
      }
      if (action === 'remove' && value) {
        await ctx.database.remove('mc_global_servers', { address: value })
        return t('globalSetRemove', value)
      }
      if (action === 'list') {
        const servers = await ctx.database.get('mc_global_servers', {})
        const list = servers.map(s => `${s.address} (${s.type})`).join('\n') || '（空）'
        return t('globalSetList', list)
      }
    })

  ctx.command('mc-skin <player:text>', '查看正版玩家皮肤')
    .action(async ({ session }, player) => {
      debugLog(`[mc-skin] 查询皮肤: ${player}`)
      if (!player) return t('skinNotFound')
      const buffer = await fetchSkin(player)
      if (!buffer) return t('skinNotFound')
      return h.image(buffer, 'image/png')
    })

  ctx.command('mc-update', '查看版本更新')
    .action(async () => {
      debugLog(`[mc-update] 检查版本`)
      try {
        const response = await axios.get('https://piston-meta.mojang.com/mc/game/version_manifest.json', { timeout: 10000 })
        if (config.debug) logger.info(`[mc-update] 版本清单响应: ${JSON.stringify(response.data)}`)
        const { latest, versions } = response.data
        if (!latest || !versions) return t('mcUpdateError')
        const release = versions.find((v: any) => v.id === latest.release)
        const snapshot = versions.find((v: any) => v.id === latest.snapshot)
        if (!release || !snapshot) return t('mcUpdateError')

        const cached = await ctx.database.get('mc_version_cache', {})
        const lastRelease = cached.length ? cached[0].releaseId : ''
        const lastSnapshot = cached.length ? cached[0].snapshotId : ''

        if (release.id === lastRelease && snapshot.id === lastSnapshot) {
          return t('mcUpdateNoUpdate')
        }

        if (cached.length) {
          await ctx.database.set('mc_version_cache', { id: cached[0].id }, {
            releaseId: release.id,
            snapshotId: snapshot.id,
            updatedAt: new Date(),
          })
        } else {
          await ctx.database.create('mc_version_cache', {
            releaseId: release.id,
            snapshotId: snapshot.id,
          })
        }

        const parts: string[] = []
        if (release.id !== lastRelease) {
          parts.push(`${t('mcUpdateRelease')}: ${release.id}`)
          parts.push(`  时间: ${new Date(release.releaseTime).toLocaleString('zh-CN')}`)
        }
        if (snapshot.id !== lastSnapshot) {
          parts.push(`${t('mcUpdateSnapshot')}: ${snapshot.id}`)
          parts.push(`  时间: ${new Date(snapshot.releaseTime).toLocaleString('zh-CN')}`)
        }
        return parts.join('\n')
      } catch (e: any) {
        debugLog(`[mc-update] 检查失败: ${e.message}`)
        return t('mcUpdateError')
      }
    })

  function scheduleDailyTask(timeStr: string, task: () => void) {
    const { hour, minute } = parseTime(timeStr)
    const now = new Date()
    const target = new Date(now)
    target.setHours(hour, minute, 0, 0)
    if (target <= now) target.setDate(target.getDate() + 1)
    const delay = target.getTime() - now.getTime()
    setTimeout(() => {
      task()
      scheduleDailyTask(timeStr, task)
    }, delay)
  }

  if (config.enableAutoUpdatePush) {
    scheduleDailyTask(config.autoUpdateTime, async () => {
      debugLog(`[auto-update] 定时检查版本`)
      try {
        const response = await axios.get('https://piston-meta.mojang.com/mc/game/version_manifest.json', { timeout: 10000 })
        if (config.debug) logger.info(`[auto-update] 版本清单响应: ${JSON.stringify(response.data)}`)
        const { latest, versions } = response.data
        if (!latest || !versions) return
        const release = versions.find((v: any) => v.id === latest.release)
        const snapshot = versions.find((v: any) => v.id === latest.snapshot)
        if (!release || !snapshot) return

        const cached = await ctx.database.get('mc_version_cache', {})
        const lastRelease = cached.length ? cached[0].releaseId : ''
        const lastSnapshot = cached.length ? cached[0].snapshotId : ''

        if (release.id === lastRelease && snapshot.id === lastSnapshot) return

        if (cached.length) {
          await ctx.database.set('mc_version_cache', { id: cached[0].id }, {
            releaseId: release.id,
            snapshotId: snapshot.id,
            updatedAt: new Date(),
          })
        } else {
          await ctx.database.create('mc_version_cache', {
            releaseId: release.id,
            snapshotId: snapshot.id,
          })
        }

        const parts: string[] = []
        if (release.id !== lastRelease) parts.push(`🟢 正式版 ${release.id} 发布`)
        if (snapshot.id !== lastSnapshot) parts.push(`🟠 快照版 ${snapshot.id} 发布`)
        const message = parts.join('\n')
        if (!message) return

        if (config.enableGroupIsolation) {
          const servers = await ctx.database.get('mc_guild_servers', {})
          const guildIds = [...new Set(servers.map(s => s.guildId))]
          for (const gid of guildIds) {
            const bot = ctx.bots.find(b => b.supports('sendMessage', { guildId: gid }))
            if (bot) await bot.sendMessage(gid, message).catch(() => {})
          }
        } else {
          for (const bot of ctx.bots) {
            const guilds = (bot as any).guilds || []
            for (const g of guilds) await bot.sendMessage(g.id, message).catch(() => {})
          }
        }
      } catch { }
    })
  }
}