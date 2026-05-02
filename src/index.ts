import { Schema, Logger, segment, Context, h } from 'koishi'
import axios from 'axios'
import yaml from 'yaml'
import fs from 'fs'
import path from 'path'

export const name = 'ai-image'
export const inject = {
  required: ['console', 'i18n'],
  optional: ['assets'],
}

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

  enableTxt2Img: Schema.boolean().default(true).description('启用文生图'),
  enableImg2Img: Schema.boolean().default(true).description('启用图生图'),

  command: Schema.string()
    .default('draw')
    .description('文生图指令（仅在启用文生图时有效）'),
  aliases: Schema.array(String)
    .default([])
    .description('文生图指令别名（仅在启用文生图时有效）'),

  img2imgCommand: Schema.string()
    .default('imgdraw')
    .description('图生图指令（仅在启用图生图时有效）'),
  img2imgAliases: Schema.array(String)
    .default([])
    .description('图生图指令别名（仅在启用图生图时有效）'),

  messages: Schema.object({
    generating: Schema.string().default('⏳ 生成中...').description('生成中提示'),
    waitImage: Schema.string().default('请在60秒内发送需要编辑的图片').description('等待图片提示'),
    timeout: Schema.string().default('等待图片超时，已取消').description('超时提示'),
    empty: Schema.string().default('❌ 请输入提示词').description('无提示词提示'),
    noApi: Schema.string().default('❌ 未配置可用API').description('无可用API提示'),
    fail: Schema.string().default('❌ 生成失败').description('生成失败提示'),
    needAssets: Schema.string().default('❌ 图生图需要正确配置 assets 服务的 selfUrl（当前链接非公网地址）').description('assets 返回非公网链接提示'),
  }).description('提示文案配置'),
}).description('AI 绘图插件配置')

export async function apply(ctx: Context, cfg: Infer<typeof Config>) {
  const debug = cfg.debug

  const TXT2IMG_PROMPT_PREFIX = '请严格遵循我的要求生成一张图片，不要询问或添加额外说明，直接输出图片。你可以使用联网功能获取最新的数据或信息。要求：'
  const IMG2IMG_PROMPT_PREFIX = '请严格根据以下指令对提供的图片进行编辑或重绘，不要询问，直接输出结果。你可以使用联网功能获取最新的数据或信息。'

  try {
    const loc = path.join(__dirname, 'locales', 'zh-CN.yml')
    if (fs.existsSync(loc)) {
      ctx.i18n.define('zh-CN', yaml.parse(fs.readFileSync(loc, 'utf8')))
    }
  } catch (e) {}

  const waitingMap = new Map<string, { prompt: string; timer: NodeJS.Timeout }>()
  const idx = { val: 0 }

  const assets = (ctx as any).assets

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

  async function safeSend(session: any, message: string | h) {
    try {
      await session.send(message)
    } catch (e) {
      logger.error('[ai-image] 发送消息失败', e)
    }
  }

  async function generate(session: any, prompt: string, imageUrl?: string) {
    const api = getApi()
    if (!api) {
      if (debug) logger.info('[DEBUG] 无可用API')
      await safeSend(session, cfg.messages.noApi)
      return
    }

    let content: any
    if (imageUrl) {
      content = [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: imageUrl } }
      ]
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
        await safeSend(session, segment.image(imgUrl.trim()))
      } else {
        await safeSend(session, cfg.messages.fail)
      }
    } catch (err) {
      logger.error('[ai-image] API请求失败', err)
      await safeSend(session, cfg.messages.fail)
    }
  }

  const cmd = ctx.command(`${cfg.command} <raw:text>`)
  cfg.aliases.forEach(alias => cmd.alias(alias))
  cmd.action(async ({ session }, raw) => {
    try {
      if (!session || !cfg.enableTxt2Img) return
      const prompt = cleanHtmlTags(raw || '')
      if (!prompt) return safeSend(session, cfg.messages.empty)
      await safeSend(session, cfg.messages.generating)
      await generate(session, TXT2IMG_PROMPT_PREFIX + prompt)
    } catch (e) {
      logger.error('[ai-image] 文生图命令异常', e)
      await safeSend(session, cfg.messages.fail)
    }
  })

  const imgCmd = ctx.command(`${cfg.img2imgCommand} <raw:text>`)
  cfg.img2imgAliases.forEach(alias => imgCmd.alias(alias))
  imgCmd.action(async ({ session }, raw) => {
    try {
      if (!session || !cfg.enableImg2Img) return
      if (!assets) return safeSend(session, cfg.messages.needAssets)
      const prompt = cleanHtmlTags(raw || '')
      if (!prompt) return safeSend(session, cfg.messages.empty)

      const key = `${session.guildId || 'private'}-${session.userId}`
      if (waitingMap.has(key)) return

      await safeSend(session, cfg.messages.waitImage.replace('60', String(cfg.imgWaitTime)))
      const timer = setTimeout(() => {
        waitingMap.delete(key)
        safeSend(session, cfg.messages.timeout)
      }, cfg.imgWaitTime * 1000)
      waitingMap.set(key, { prompt, timer })
    } catch (e) {
      logger.error('[ai-image] 图生图命令异常', e)
      await safeSend(session, cfg.messages.fail)
    }
  })

  ctx.on('message', async (session) => {
    try {
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
      await safeSend(session, cfg.messages.generating)

      try {
        const assetUrl = await assets.upload(src, 'ref_image.jpg')
        if (debug) logger.info('[DEBUG] assets返回链接:', assetUrl)

        if (!/^https?:\/\//.test(assetUrl)) {
          if (debug) logger.warn('[DEBUG] 非公网链接，请检查 assets 的 selfUrl 设置')
          await safeSend(session, cfg.messages.needAssets)
          return
        }

        await generate(session, IMG2IMG_PROMPT_PREFIX + task.prompt, assetUrl)
      } catch (e) {
        logger.error('[ai-image] 图片处理失败', e)
        await safeSend(session, cfg.messages.fail)
      }
    } catch (e) {
      logger.error('[ai-image] 未捕获的异常', e)
      await safeSend(session, cfg.messages.fail)
    }
  })
}