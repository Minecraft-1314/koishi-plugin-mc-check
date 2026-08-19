import { Context, Schema, h } from 'koishi'
import axios from 'axios'
import path from 'node:path'
import fs from 'node:fs'
import net from 'node:net'
import dgram from 'node:dgram'

export const inject = {
  required: ['database'],
  optional: ['puppeteer'],
}

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
    mcCheckNoServer: string
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
  }
}

interface McVersionCache {
  id: number
  releaseId: string
  snapshotId: string
  updatedAt: Date
}

interface McPluginConfig {
  id: number
  key: string
  value: string
}

declare module 'koishi' {
  interface Tables {
    mc_version_cache: McVersionCache
    mc_plugin_config: McPluginConfig
  }
}

function parseHostPort(raw: string, defaultPort: number): { host: string; port: number } {
  const match = raw.match(/^(.+):(\d{1,5})$/)
  if (match) {
    const port = parseInt(match[2], 10)
    if (port >= 1 && port <= 65535) return { host: match[1], port }
  }
  return { host: raw, port: defaultPort }
}

function parseTime(timeStr: string): { hour: number; minute: number } {
  const [h, m] = timeStr.split(':').map(Number)
  return { hour: h, minute: m }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
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

function encodeVarInt(value: number): Buffer {
  const bytes: number[] = []
  let v = value
  do {
    let temp = v & 0x7F
    v >>>= 7
    if (v !== 0) temp |= 0x80
    bytes.push(temp)
  } while (v !== 0)
  return Buffer.from(bytes)
}

function decodeVarInt(buffer: Buffer, offset: number = 0): { value: number; length: number } {
  let value = 0
  let position = 0
  let currentByte: number
  let i = offset
  do {
    currentByte = buffer[i]
    value |= (currentByte & 0x7F) << (position * 7)
    position++
    if (position > 5) throw new Error('VarInt too big')
    i++
  } while ((currentByte & 0x80) !== 0)
  return { value, length: i - offset }
}

function createHandshakePacket(host: string, port: number, protocolVersion: number = 47): Buffer {
  const hostBuf = Buffer.from(host, 'utf-8')
  const portBuf = Buffer.alloc(2)
  portBuf.writeUInt16BE(port, 0)

  const packetId = Buffer.from([0x00])
  const protocolVersionBuf = encodeVarInt(protocolVersion)
  const hostLengthBuf = encodeVarInt(hostBuf.length)
  const nextStateBuf = Buffer.from([0x01])

  const payload = Buffer.concat([
    packetId,
    protocolVersionBuf,
    hostLengthBuf,
    hostBuf,
    portBuf,
    nextStateBuf,
  ])

  const length = encodeVarInt(payload.length)
  return Buffer.concat([length, payload])
}

function createStatusRequestPacket(): Buffer {
  const packetId = Buffer.from([0x00])
  const length = encodeVarInt(packetId.length)
  return Buffer.concat([length, packetId])
}

function readVarIntFromSocket(socket: net.Socket): Promise<number> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      try {
        const { value, length } = decodeVarInt(buffer, 0)
        if (length > 0 && buffer.length >= length) {
          socket.removeListener('data', onData)
          resolve(value)
        }
      } catch {
        // continue receiving
      }
    }
    socket.on('data', onData)
    socket.on('error', reject)
    socket.on('timeout', () => reject(new Error('timeout')))
  })
}

function readPacket(socket: net.Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      try {
        const { value: packetLength, length: varIntLength } = decodeVarInt(buffer, 0)
        if (packetLength > 0 && buffer.length >= varIntLength + packetLength) {
          const packet = buffer.slice(varIntLength, varIntLength + packetLength)
          socket.removeListener('data', onData)
          resolve(packet)
        }
      } catch {
        // continue receiving
      }
    }
    socket.on('data', onData)
    socket.on('error', reject)
    socket.on('timeout', () => reject(new Error('timeout')))
  })
}

function extractMotd(description: any): string {
  if (!description) return ''
  if (typeof description === 'string') return description
  if (typeof description === 'object') {
    if (description.text) return description.text
    if (description.extra) {
      return description.extra.map((part: any) => extractMotd(part)).join('')
    }
    if (description.translate) return description.translate
  }
  return ''
}

function createBedrockPingPacket(): Buffer {
  const magic = Buffer.from([0x00, 0xFF, 0xFF, 0x00, 0xFE, 0xFE, 0xFE, 0xFE, 0xFD, 0xFD, 0xFD, 0xFD, 0x12, 0x34, 0x56, 0x78])
  const clientGuid = Buffer.alloc(8)
  const timestamp = Buffer.alloc(8)
  const packet = Buffer.concat([
    Buffer.from([0x01]),
    timestamp,
    magic,
    clientGuid,
  ])
  return packet
}

function parseBedrockPong(buffer: Buffer): any {
  if (buffer[0] !== 0x1c) throw new Error('Invalid pong packet')
  let offset = 1
  offset += 8
  offset += 16
  offset += 8

  const readString = () => {
    const len = buffer.readUInt16BE(offset)
    offset += 2
    const str = buffer.slice(offset, offset + len).toString('utf-8')
    offset += len
    return str
  }

  const serverName = readString()
  const protocolVersion = buffer[offset]
  offset += 1
  const version = readString()
  const onlinePlayers = buffer.readUInt32BE(offset)
  offset += 4
  const maxPlayers = buffer.readUInt32BE(offset)
  offset += 4
  const motd = readString()
  const gameMode = readString()
  const gameModeId = buffer.readUInt32BE(offset)
  offset += 4
  const portIpv4 = buffer.readUInt16BE(offset)
  offset += 2
  const portIpv6 = buffer.readUInt16BE(offset)
  offset += 2

  return {
    serverName,
    protocolVersion,
    version,
    onlinePlayers,
    maxPlayers,
    motd,
    gameMode,
  }
}

async function fetchJavaServerStatus(host: string, port: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket()
    const timeout = 5000
    const startTime = Date.now()
    let settled = false

    socket.setTimeout(timeout)
    socket.on('timeout', () => {
      if (!settled) {
        settled = true
        socket.destroy()
        reject(new Error('timeout'))
      }
    })
    socket.on('error', (err) => {
      if (!settled) {
        settled = true
        socket.destroy()
        reject(err)
      }
    })

    socket.connect(port, host, async () => {
      try {
        const handshake = createHandshakePacket(host, port)
        const statusRequest = createStatusRequestPacket()
        socket.write(handshake)
        socket.write(statusRequest)

        const packet = await readPacket(socket)
        const packetId = packet[0]
        if (packetId !== 0x00) throw new Error('Invalid packet ID')

        const jsonStr = packet.slice(1).toString('utf-8')
        const data = JSON.parse(jsonStr)

        const latency = Date.now() - startTime
        socket.destroy()

        const version = data.version?.name || data.version || '未知'
        const motd = extractMotd(data.description)
        const playersOnline = data.players?.online ?? 0
        const playersMax = data.players?.max ?? 0
        const playerList = data.players?.sample?.map((p: any) => p.name) || []
        const icon = data.favicon || null

        resolve({
          online: true,
          host,
          port,
          version: { name_raw: version },
          motd: { clean: motd },
          players: {
            online: playersOnline,
            max: playersMax,
            list: playerList,
          },
          ping: latency,
          icon,
          software: null,
          plugins: [],
          mods: [],
          error: null,
        })
      } catch (err: any) {
        socket.destroy()
        if (!settled) {
          settled = true
          reject(err)
        }
      }
    })
  })
}

async function fetchBedrockServerStatus(host: string, port: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4')
    const startTime = Date.now()
    let settled = false

    const timeout = 5000
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        socket.close()
        reject(new Error('timeout'))
      }
    }, timeout)

    socket.on('message', (msg) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        socket.close()
        try {
          const data = parseBedrockPong(msg)
          const latency = Date.now() - startTime
          resolve({
            online: true,
            host,
            port,
            version: { name_raw: data.version || '未知' },
            motd: { clean: data.motd || data.serverName || '' },
            players: {
              online: data.onlinePlayers,
              max: data.maxPlayers,
              list: [],
            },
            ping: latency,
            icon: null,
            software: data.gameMode || null,
            plugins: [],
            mods: [],
            error: null,
          })
        } catch (err: any) {
          reject(err)
        }
      }
    })

    socket.on('error', (err) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        socket.close()
        reject(err)
      }
    })

    try {
      const packet = createBedrockPingPacket()
      socket.send(packet, port, host)
    } catch (err) {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        socket.close()
        reject(err)
      }
    }
  })
}

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
    mcCheckNoServer: Schema.string().description('无服务器提示').default('请提供服务器地址'),
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

  function getPuppeteer(): any {
    try {
      const svc = (ctx as any).puppeteer
      if (svc) return svc
      return (ctx as any).get?.('puppeteer')
    } catch {
      return undefined
    }
  }

  let fontBase64 = ''
  let bgBase64 = ''

  ctx.model.extend('mc_plugin_config', {
    id: 'unsigned',
    key: 'string',
    value: 'string',
  }, {
    primary: 'id',
    autoInc: true,
    unique: ['key'],
  })

  async function getConfigValue(key: string, defaultValue: string): Promise<string> {
    try {
      const rows = await ctx.database.get('mc_plugin_config', { key })
      if (rows.length) return rows[0].value
    } catch {}
    return defaultValue
  }

  async function setConfigValue(key: string, value: string): Promise<void> {
    try {
      const existing = await ctx.database.get('mc_plugin_config', { key })
      if (existing.length) {
        await ctx.database.set('mc_plugin_config', { key }, { value })
      } else {
        await ctx.database.create('mc_plugin_config', { key, value })
      }
    } catch {}
  }

  let cardImageEnabled = config.enableCardImage

  ctx.on('ready', async () => {
    const raw = await getConfigValue('enableCardImage', String(config.enableCardImage))
    if (raw !== String(config.enableCardImage)) {
      await setConfigValue('enableCardImage', String(config.enableCardImage))
      cardImageEnabled = config.enableCardImage
    } else {
      cardImageEnabled = raw === 'true'
    }

    const puppeteer = getPuppeteer()
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
      'mc-update': { description: '查看版本更新' },
      'mc-skin': { description: '查看正版玩家皮肤' },
    },
  })

  function t(key: keyof McCheckConfig['messages'], ...args: any[]): string {
    let tmpl = config.messages[key] || key
    for (let i = 0; i < args.length; i++) {
      tmpl = tmpl.split(`{${i}}`).join(args[i])
    }
    return tmpl
  }

  ctx.model.extend('mc_version_cache', {
    id: 'unsigned',
    releaseId: 'string',
    snapshotId: 'string',
    updatedAt: 'timestamp',
  }, { primary: 'id', autoInc: true })

  async function fetchServerStatus(host: string, type: 'java' | 'bedrock'): Promise<any> {
    const defaultPort = type === 'bedrock' ? 19132 : 25565
    const { host: h, port } = parseHostPort(host, defaultPort)
    const targetPort = port || defaultPort

    try {
      if (type === 'java') {
        return await fetchJavaServerStatus(h, targetPort)
      } else {
        return await fetchBedrockServerStatus(h, targetPort)
      }
    } catch (err: any) {
      return {
        online: false,
        host: h,
        port: targetPort,
        version: null,
        motd: null,
        players: null,
        ping: null,
        icon: null,
        software: null,
        plugins: [],
        mods: [],
        error: err.message || String(err),
      }
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

  function formatStatus(status: any, label: string): string {
    if (!status.online) return `❌ ${escapeHtml(label)} - 离线${status.error ? ` (${escapeHtml(status.error)})` : ''}`

    const motd = status.motd?.clean || ''
    const players = status.players
    const playerStr = players ? `${players.online}/${players.max}` : '?/?'
    const playerList = players?.online && players.list?.length
      ? `\n  在线: ${players.list.map((p: any) => p.name || p).join(', ')}`
      : ''
    const pingStr = status.ping !== null ? `  📶 ${status.ping}ms` : ''
    const software = status.software ? `\n⚙️ 服务端: ${status.software}` : ''

    return [
      `🟢 ${escapeHtml(label)}:${status.port || 25565}${pingStr}`,
      `📋 版本: ${status.version?.name_raw || status.version || '未知'}`,
      `👥 玩家: ${playerStr}${playerList}`,
      motd ? `💬 MOTD: ${motd}` : '',
      software,
    ].filter(Boolean).join('\n')
  }

  const uuidCache = new Map<string, string | null>()

  async function fetchUuid(username: string): Promise<string | null> {
    if (uuidCache.has(username)) return uuidCache.get(username)!
    const url = `https://api.mojang.com/users/profiles/minecraft/${username}`
    debugLog(`[mc-skin] 请求 UUID: ${url}`)
    try {
      const { data } = await axios.get(url, { timeout: 5000 })
      if (config.debug) logger.info(`[mc-skin] UUID 响应: ${JSON.stringify(data)}`)
      const result = data?.id || null
      uuidCache.set(username, result)
      return result
    } catch (e: any) {
      debugLog(`[mc-skin] UUID 请求失败: ${e.message}`)
      uuidCache.set(username, null)
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

  async function fetchVersionInfo(): Promise<{ release: any; snapshot: any } | null> {
    try {
      const response = await axios.get('https://piston-meta.mojang.com/mc/game/version_manifest.json', { timeout: 10000 })
      const { latest, versions } = response.data
      if (!latest || !versions) return null
      const release = versions.find((v: any) => v.id === latest.release)
      const snapshot = versions.find((v: any) => v.id === latest.snapshot)
      if (!release || !snapshot) return null
      return { release, snapshot }
    } catch {
      return null
    }
  }

  function getGlobalServers(): Array<{ address: string; type: 'java' | 'bedrock' }> {
    return config.globalServers.map((s: string) => ({ address: s, type: config.globalServerType }))
  }

  async function renderStatusCard(status: any, label: string): Promise<Buffer | null> {
    const puppeteer = getPuppeteer()
    if (!puppeteer) return null

    const online: boolean = status.online
    const hostDisplay = escapeHtml(label)
    const version = escapeHtml(status.version?.name_raw || status.version || '未知')
    const players = status.players
    const playerOnline = players?.online ?? 0
    const playerMax = players?.max ?? 0
    const motdText = escapeHtml(status.motd?.clean || '')
    const ping = status.ping !== null ? status.ping : 0
    const software = escapeHtml(status.software || '')
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

  ctx.command('mc-check [address:text]', '查询 Minecraft 服务器状态')
    .option('type', '-t <type:string>')
    .action(async ({ session, options }: any, address: string | undefined) => {
      debugLog(`[mc-check] 指令触发，参数: address=${address}, type=${options?.type}`)
      const requestedType: 'java' | 'bedrock' = (options?.type as 'java' | 'bedrock') || config.globalServerType
      if (!address) {
        const targets = getGlobalServers()
        if (!targets.length) return t('mcCheckNoGlobal')
        debugLog(`[mc-check] 批量查询目标: ${JSON.stringify(targets.map((t: any) => t.address))}`)
        const CONCURRENCY = 5
        const results: string[] = []
        for (let i = 0; i < targets.length; i += CONCURRENCY) {
          const batch = targets.slice(i, i + CONCURRENCY)
          const batchResults = await Promise.all(batch.map(async (target: any) => {
            const status = await fetchWithFallback(target.address, target.type)
            return formatStatus(status, target.address)
          }))
          results.push(...batchResults)
        }
        return results.join('\n\n')
      }

      const status = await fetchWithFallback(address, requestedType)

      if (cardImageEnabled) {
        const img = await renderStatusCard(status, address)
        if (img) return h.image(img, 'image/jpeg')
        return formatStatus(status, address)
      }
      return formatStatus(status, address)
    })

  ctx.command('mc-skin <player:text>', '查看正版玩家皮肤')
    .action(async ({ session }: any, player: string | undefined) => {
      debugLog(`[mc-skin] 查询皮肤: ${player}`)
      if (!player) return t('skinNotFound')
      const buffer = await fetchSkin(player)
      if (!buffer) return t('skinNotFound')
      return h.image(buffer, 'image/png')
    })

  ctx.command('mc-update', '查看版本更新')
    .action(async ({ session }: any) => {
      debugLog('[mc-update] 检查版本')
      try {
        const versionInfo = await fetchVersionInfo()
        if (!versionInfo) return t('mcUpdateError')
        const { release, snapshot } = versionInfo

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
        debugLog(`[mc-update] 检查版本失败: ${e.message}`)
        return `${t('mcUpdateError')}（${e.message}）`
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
      debugLog('[auto-update] 定时检查版本')
      try {
        const versionInfo = await fetchVersionInfo()
        if (!versionInfo) return
        const { release, snapshot } = versionInfo

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

        for (const bot of ctx.bots) {
          try {
            const guilds: any = await bot.getGuildList()
            for (const guild of guilds) {
              const targetId = guild.guildId || guild.id
              if (targetId) {
                await bot.sendMessage(targetId, message).catch(() => {})
              }
            }
          } catch (err: any) {
            debugLog(`[auto-update] 获取群列表失败: ${err.message}`)
          }
        }
      } catch { }
    })
  }
}