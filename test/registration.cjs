const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const { App, h } = require('koishi')
const plugin = require('../lib')
const { formatStatus, parseHostPort } = require('../lib/utils')

const expected = [
  'mc-check',
  'mc-skin',
  'mc-update',
  '接收更新推送',
  '关闭更新推送',
  '更新推送状态',
]
const uuid = '069a79f444e94726a5befca90e38aaf5'
const versionInfo = {
  latest: { release: '1.21.4', snapshot: '25w41a' },
  versions: [
    { id: '1.21.4', releaseTime: '2024-12-03T12:00:00.000Z' },
    { id: '25w41a', releaseTime: '2025-10-09T12:00:00.000Z' },
  ],
}

function createHttp() {
  return {
    async get(url) {
      if (url.includes('piston-meta.mojang.com')) return versionInfo
      if (url.includes('api.mojang.com')) return { id: uuid }
      if (url.includes('visage.surgeplay.com')) return Buffer.from('skin')
      if (url.includes('/bedrock/')) {
        return {
          online: true,
          hostname: 'example.com',
          port: 19132,
          version: 'Bedrock 1.21.40',
          motd: { clean: ['Bedrock Server'] },
          players: { online: 3, max: 20 },
        }
      }
      if (url.includes('api.mcsrvstat.us')) {
        return {
          online: true,
          hostname: 'example.com',
          port: 25565,
          version: 'Java 1.21.4',
          motd: { clean: ['Java Server'] },
          players: {
            online: 5,
            max: 100,
            list: [{ name: 'Notch' }, { name_clean: 'Steve' }],
          },
          software: 'Paper',
          icon: 'data:image/png;base64,aGVsbG8=',
        }
      }
      throw new Error(`unexpected url: ${url}`)
    },
  }
}

function createDatabase() {
  const users = new Map()
  const channels = new Map()
  const state = { cache: null }
  return {
    state,
    async get(table, query) {
      if (table === 'mc_version_cache') return state.cache ? [state.cache] : []
      if (table === 'user') {
        return [...users.values()].filter(user => query.id?.$in?.includes(user.id))
      }
      if (table === 'channel') return []
      if (table === 'binding') return []
      return []
    },
    async upsert(table, rows) {
      assert.strictEqual(table, 'mc_version_cache')
      state.cache = { ...rows[0] }
    },
    async getUser(platform, id) {
      return users.get(`${platform}:${id}`)
    },
    async setUser(platform, id, data) {
      const key = `${platform}:${id}`
      if (!users.has(key)) throw new Error('missing user')
      Object.assign(users.get(key), data)
    },
    async createUser(platform, id, data) {
      const key = `${platform}:${id}`
      const user = { id: users.size + 1, authority: 1, ...data }
      users.set(key, user)
      return user
    },
    async getChannel(platform, id) {
      return channels.get(`${platform}:${id}`)
    },
    async setChannel(platform, id, data) {
      const key = `${platform}:${id}`
      if (!channels.has(key)) throw new Error('missing channel')
      Object.assign(channels.get(key), data)
    },
    async createChannel(platform, id, data) {
      const key = `${platform}:${id}`
      const channel = { platform, id, ...data }
      channels.set(key, channel)
      return channel
    },
  }
}

function createPuppeteer() {
  const state = { closed: false }
  const page = {
    async setViewport() {},
    async goto() {},
    async setContent() {},
    async evaluate() {},
    async waitForNetworkIdle() {},
    async waitForTimeout() {},
    async screenshot() {
      return Buffer.from('jpeg')
    },
    async close() {
      state.closed = true
    },
  }
  return {
    state,
    async page() {
      return page
    },
  }
}

function createSession(extra = {}) {
  return {
    platform: 'test',
    userId: '1',
    channelId: '1',
    isDirect: true,
    text: (value) => value,
    ...extra,
  }
}

async function execute(command, args, options, session) {
  return await command.execute({ args, options, session: session || createSession() })
}

async function testUtilities() {
  assert.deepStrictEqual(parseHostPort('example.com:25566', 25565), {
    host: 'example.com',
    port: 25566,
  })
  assert.deepStrictEqual(parseHostPort('[::1]:25565', 25566), {
    host: '[::1]',
    port: 25565,
  })
  assert.deepStrictEqual(parseHostPort('::1', 25565), {
    host: '::1',
    port: 25565,
  })
  const timeout = formatStatus({
    online: false,
    host: 'example.com',
    port: 25565,
    version: '',
    motd: '',
    players: { online: 0, max: 0, list: [] },
    ping: null,
    icon: null,
    software: null,
    error: 'request timeout',
  }, 'example.com', '查询超时')
  assert(timeout.includes('查询超时'))
}

async function testRollback() {
  const app = new App()
  const existing = app.command('mc-update', 'existing').action(() => 'existing')
  const fork = app.plugin(plugin, plugin.Config({}))
  await new Promise(resolve => setImmediate(resolve))
  assert.strictEqual(fork.runtime.status, 3)
  assert(!app.$commander.get('mc-check'))
  assert(!app.$commander.get('mc-skin'))
  assert(!app.$commander.get('接收更新推送'))
  assert.strictEqual(existing._actions.length, 1)
}

async function testMain() {
  const app = new App()
  const database = createDatabase()
  const puppeteer = createPuppeteer()
  app.set('database', database)
  app.set('http', createHttp())
  app.set('puppeteer', puppeteer)
  const config = plugin.Config({
    globalServers: [],
    enableCardImage: true,
  })
  app.plugin(plugin, config)
  await app.start()
  try {
    for (const name of expected) {
      const command = app.$commander.get(name)
      assert(command, `missing command: ${name}`)
      assert(command._actions.length > 0, `command has no action: ${name}`)
    }
    assert.strictEqual(plugin.name, 'mc-check')

    const command = app.$commander.get('mc-check')
    const parsed = command.parse('example.com -t bedrock')
    assert.deepStrictEqual(parsed.args, ['example.com'])
    assert.strictEqual(parsed.options.type, 'bedrock')

    const noGlobal = await execute(command, [], {})
    assert.strictEqual(noGlobal, config.messages.mcCheckNoGlobal)
    const invalidType = await execute(command, ['example.com'], { type: 'invalid' })
    assert.strictEqual(invalidType, config.messages.mcCheckInvalidType)

    parsed.session = createSession()
    const card = await command.execute(parsed)
    assert(h.normalize(card).join('').includes('<img'))
    assert.strictEqual(puppeteer.state.closed, true)

    const skinCommand = app.$commander.get('mc-skin')
    const skin = await execute(skinCommand, ['Notch'], {})
    const skinText = h.normalize(skin).join('')
    assert(skinText.includes('Notch 的皮肤'))
    assert(skinText.includes('<img'))

    const updateCommand = app.$commander.get('mc-update')
    const update = await execute(updateCommand, [], {})
    assert.strictEqual(update, config.messages.mcUpdateNoUpdate)

    const enable = await execute(app.$commander.get('接收更新推送'), [], {})
    assert.strictEqual(enable, '你的私聊更新推送：开启')
    const status = await execute(app.$commander.get('更新推送状态'), [], {})
    assert.strictEqual(status, '你的私聊更新推送：开启')
    const disable = await execute(app.$commander.get('关闭更新推送'), [], {})
    assert.strictEqual(disable, '你的私聊更新推送：关闭')

    const groupSession = createSession({
      isDirect: false,
      guildId: 'guild',
      channelId: 'channel',
      bot: {},
      event: { member: { roles: ['admin'] } },
    })
    const groupEnable = await execute(app.$commander.get('接收更新推送'), [], {}, groupSession)
    assert.strictEqual(groupEnable, '本群更新推送：开启')
    const groupStatus = await execute(app.$commander.get('更新推送状态'), [], {}, groupSession)
    assert.strictEqual(groupStatus, '本群更新推送：开启')
  } finally {
    await app.stop()
  }
}

async function testMissingServices() {
  const app = new App()
  app.set('http', createHttp())
  const config = plugin.Config({ enableCardImage: true })
  app.plugin(plugin, config)
  await app.start()
  try {
    const result = await execute(app.$commander.get('mc-check'), ['example.com'], {})
    assert(String(result).includes(config.messages.puppeteerRequired))
    const push = await execute(app.$commander.get('接收更新推送'), [], {})
    assert.strictEqual(push, config.messages.databaseRequired)
  } finally {
    await app.stop()
  }
}

async function main() {
  await testUtilities()
  await testRollback()
  await testMain()
  await testMissingServices()
  const leftover = fs.readdirSync(os.tmpdir())
    .filter(name => name.startsWith('koishi-mc-card-'))
  assert.deepStrictEqual(leftover, [])
  console.log(`commands=${expected.length} scenarios=4`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
