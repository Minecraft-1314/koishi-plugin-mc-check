import { Schema, Logger, segment, Context, h } from 'koishi'
import axios from 'axios'
import fs from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import yaml from 'yaml'
import crypto from 'crypto'

export const name = 'ai-image'
export const inject = ['console', 'i18n']

const logger = new Logger('ai-image')

type Infer<T> = T extends Schema<infer U> ? U : never

export const Config = Schema.object({
  debug: Schema.boolean().default(false).description('开启调试模式，输出完整请求日志'),
  apiStrategy: Schema.union([
    Schema.const('sequence').description('顺序模式'),
    Schema.const('roundrobin').description('负载均衡模式'),
  ]).default('roundrobin').description('API 调度策略'),
  timeout: Schema.number().default(300000).description('接口请求超时时间（毫秒）'),
  rateLimit: Schema.number().default(200).description('每小时调用次数限制'),
  imgWaitTime: Schema.number().default(60).description('图生图等待图片超时时间（秒）'),

  model: Schema.string().default('gpt-4o-mini').description('模型名称'),

  apiList: Schema.array(Schema.object({
    enable: Schema.boolean().default(true).description('启用此 API'),
    apiKey: Schema.string().description('API Key'),
    baseUrl: Schema.string().description('接口地址，需符合 OpenAI 标准'),
  })).default([]).description('API 配置列表（支持多账号负载）'),

  command: Schema.string().default('draw').description('文生图指令'),
  aliases: Schema.array(String).default([]).description('文生图指令别名'),
  img2imgCommand: Schema.string().default('imgdraw').description('图生图指令'),
  img2imgAliases: Schema.array(String).default([]).description('图生图指令别名'),

  enableTxt2Img: Schema.boolean().default(true).description('启用文生图'),
  enableImg2Img: Schema.boolean().default(true).description('启用图生图'),

  messages: Schema.object({
    generating: Schema.string().default('⏳ 生成中...').description('生成中提示'),
    waitImage: Schema.string().default('请在60秒内发送需要编辑的图片').description('等待图片提示'),
    timeout: Schema.string().default('等待图片超时，已取消').description('超时提示'),
    empty: Schema.string().default('❌ 请输入提示词').description('无提示词提示'),
    noApi: Schema.string().default('❌ 未配置可用API').description('无可用API提示'),
    noImg: Schema.string().default('❌ 生成失败').description('无图片返回提示'),
    success: Schema.string().default('✅ 生成成功').description('生成成功提示'),
    fail: Schema.string().default('❌ 生成失败').description('生成失败提示'),
  }).description('提示文案配置'),
}).description('AI 绘图插件配置')

export async function apply(ctx: Context, cfg: Infer<typeof Config>) {
  const debug = cfg.debug
  const cacheDir = path.join(process.cwd(), 'aiimage_cache')
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true })
  }

  try {
    const loc = path.join(__dirname, 'locales', 'zh-CN.yml')
    if (fs.existsSync(loc)) {
      ctx.i18n.define('zh-CN', yaml.parse(fs.readFileSync(loc, 'utf8')))
    }
  } catch (e) {}

  const waitingMap = new Map<string, { prompt: string; timer: NodeJS.Timeout }>()
  const idx = { val: 0 }

  function getApi() {
    const list = cfg.apiList.filter(v => v.enable && v.apiKey && v.baseUrl)
    if (!list.length) return null
    return cfg.apiStrategy === 'sequence' ? list[0] : list[idx.val++ % list.length]
  }

  function cleanHtmlTags(str: string) {
    return str.replace(/<[^>]+>/g, '').trim()
  }

  function getImageUrlFromContent(text: string) {
    const reg = /https?:\/\/[^<> \n\r()\[\]]+\.(png|jpg|jpeg|gif|webp)/i
    const match = text.match(reg)
    return match ? match[0] : null
  }

  async function downloadImage(url: string) {
    const hashName = crypto.createHash('md5').update(`${Date.now()}${Math.random()}`).digest('hex') + '.jpg'
    const filePath = path.join(cacheDir, hashName)
    const res = await axios({ url, responseType: 'stream', timeout: 30000 })
    await pipeline(res.data, fs.createWriteStream(filePath))
    return filePath
  }

  function fileToBase64(filePath: string) {
    const img = fs.readFileSync(filePath)
    return `data:image/jpeg;base64,${img.toString('base64')}`
  }

  async function generateImage(session: any, prompt: string, imgPath = '') {
    const api = getApi()
    if (!api) {
      if (debug) logger.info('[DEBUG] 无可用API')
      await session.send(cfg.messages.noApi)
      return
    }

    let content
    if (imgPath) {
      const base64 = fileToBase64(imgPath)
      content = `请解析下方的图片BASE64编码，严格根据我的要求编辑、重绘这张图片：${prompt}\n${base64}`
    } else {
      content = prompt
    }

    const body = {
      model: cfg.model,
      messages: [{ role: 'user', content }]
    }

    if (debug) logger.info('[DEBUG] 请求体:', JSON.stringify(body, null, 2))

    try {
      const res = await axios.post(api.baseUrl, body, {
        headers: { Authorization: `Bearer ${api.apiKey}` },
        timeout: cfg.timeout
      })

      if (debug) logger.info('[DEBUG] API返回:', JSON.stringify(res.data, null, 2))
      let imgUrl = res.data?.data?.[0]?.url || null
      if (!imgUrl) imgUrl = getImageUrlFromContent(res.data?.choices?.[0]?.message?.content || '')

      if (imgUrl) {
        await session.send(segment.image(imgUrl.trim()))
      } else {
        await session.send(cfg.messages.fail)
      }
    } catch (err) {
      if (debug) logger.error('[DEBUG] 请求失败', err)
      await session.send(cfg.messages.fail)
    } finally {
      if (imgPath && fs.existsSync(imgPath)) fs.unlinkSync(imgPath)
    }
  }

  const cmd = ctx.command(`${cfg.command} <raw:text>`)
  cfg.aliases.forEach(alias => cmd.alias(alias))
  cmd.action(async ({ session }, raw) => {
    if (!session || !cfg.enableTxt2Img) return
    const prompt = cleanHtmlTags(raw || '')
    if (!prompt) return session.send(cfg.messages.empty)
    await session.send(cfg.messages.generating)
    await generateImage(session, prompt)
  })

  const imgCmd = ctx.command(`${cfg.img2imgCommand} <raw:text>`)
  cfg.img2imgAliases.forEach(alias => imgCmd.alias(alias))
  imgCmd.action(async ({ session }, raw) => {
    if (!session || !cfg.enableImg2Img) return
    const prompt = cleanHtmlTags(raw || '')
    if (!prompt) return session.send(cfg.messages.empty)

    const key = `${session.guildId || 'private'}-${session.userId}`
    if (waitingMap.has(key)) return

    await session.send(cfg.messages.waitImage.replace('60', String(cfg.imgWaitTime)))
    const timer = setTimeout(() => {
      waitingMap.delete(key)
      session.send(cfg.messages.timeout)
    }, cfg.imgWaitTime * 1000)
    waitingMap.set(key, { prompt, timer })
  })

  ctx.on('message', async (session) => {
    if (!session.elements) return
    const key = `${session.guildId || 'private'}-${session.userId}`
    const task = waitingMap.get(key)
    if (!task) return

    const imgEl = h.select(session.elements, 'img')[0]
    if (!imgEl) return
    const src = imgEl.attrs.src
    if (!src) return

    clearTimeout(task.timer)
    waitingMap.delete(key)
    await session.send(cfg.messages.generating)

    try {
      const filePath = await downloadImage(src)
      await generateImage(session, task.prompt, filePath)
    } catch (e) {
      if (debug) logger.error('[DEBUG] 图片处理失败', e)
      await session.send(cfg.messages.fail)
    }
  })
}