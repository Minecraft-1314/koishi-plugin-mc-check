const assert = require('node:assert')
const { App, h } = require('koishi')
const plugin = require('../lib')

function createFetchHttp() {
  return {
    async get(url, options = {}) {
      const response = await fetch(url, {
        headers: options.headers,
        signal: AbortSignal.timeout(options.timeout || 10000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (options.responseType === 'arraybuffer') {
        return Buffer.from(await response.arrayBuffer())
      }
      const text = await response.text()
      try {
        return JSON.parse(text)
      } catch {
        return text
      }
    },
  }
}

function session() {
  return {
    platform: 'test',
    userId: '1',
    channelId: '1',
    isDirect: true,
    text: (value) => value,
  }
}

async function main() {
  const app = new App()
  app.set('http', createFetchHttp())
  app.plugin(plugin, plugin.Config({ requestTimeout: 10000 }))
  await app.start()
  try {
    const check = app.$commander.get('mc-check')
    const parsed = check.parse('mc.hypixel.net -t java')
    assert.deepStrictEqual(parsed.args, ['mc.hypixel.net'])
    assert.strictEqual(parsed.options.type, 'java')
    parsed.session = session()
    const status = await check.execute(parsed)
    assert(String(h.normalize(status).join('')).match(/🟢|❌/))

    const update = await app.$commander.get('mc-update').execute({
      args: [],
      options: {},
      session: session(),
    })
    assert(!String(update).includes('获取版本信息失败'))

    const skin = await app.$commander.get('mc-skin').execute({
      args: ['Notch'],
      options: {},
      session: session(),
    })
    const skinText = h.normalize(skin).join('')
    assert(skinText.includes('Notch 的皮肤') || skinText.includes('未找到该玩家'))
    console.log('network=ok')
  } finally {
    await app.stop()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
