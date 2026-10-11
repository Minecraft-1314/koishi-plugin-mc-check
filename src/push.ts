import { Bot, Context, Logger, Session } from 'koishi'
import { registerCommand } from './command'

export const UPDATE_PUSH_PREFIX = '我的世界更新'
const MAX_PAGES = 20
const MANAGER_IDS = new Set(['admin', 'administrator', 'owner', '群主', '管理员', '管理'])
const MANAGER_NAMES = new Set(['群主', '管理员', '管理', 'admin', 'owner', 'administrator', 'manager', 'moderator'])
const ADMIN_PERMISSION_BIT = 0x8n
const SETTINGS_ERROR = '更新推送设置保存失败，请稍后重试'

interface PushTarget {
  bot: Bot
  platform: string
  id: string
}

function isManagerRole(role: any): boolean {
  if (!role) return false
  if (typeof role === 'string') return MANAGER_IDS.has(role.toLowerCase())
  const id = String(role?.id ?? '').toLowerCase().replace(/\s+/g, '')
  if (MANAGER_IDS.has(id)) return true
  const name = String(role?.name ?? '').toLowerCase().replace(/\s+/g, '')
  const permissions = role?.permissions
  const hasAdminPermission = typeof permissions === 'bigint'
    ? (permissions & ADMIN_PERMISSION_BIT) === ADMIN_PERMISSION_BIT
    : typeof permissions === 'number' && (permissions & Number(ADMIN_PERMISSION_BIT)) === Number(ADMIN_PERMISSION_BIT)
  return MANAGER_NAMES.has(name)
    || hasAdminPermission
}

function getDatabase(ctx: Context): any {
  return (ctx as any).database || (ctx as any).get?.('database')
}

function hasDatabase(ctx: Context): boolean {
  return Boolean(getDatabase(ctx))
}

async function isGroupManager(ctx: Context, session: Session, logger: Logger): Promise<boolean> {
  const bot = session?.bot
  const guildId = session?.guildId
  const userId = session?.userId
  if (!bot || !guildId || !userId) return false

  try {
    const member = (session as any)?.event?.member || await bot.getGuildMember(guildId, userId)
    if (Array.isArray(member?.roles) && member.roles.some(isManagerRole)) return true
  } catch (error) {
    logger.debug(`查询群成员失败：${error}`)
  }

  try {
    const result = await bot.getGuildMemberRoleList(guildId, userId)
    const roles = Array.isArray(result) ? result : (result as any)?.data
    if (Array.isArray(roles) && roles.some(isManagerRole)) return true
  } catch (error) {
    logger.debug(`查询群角色失败：${error}`)
  }

  try {
    const database = getDatabase(ctx)
    if (!database) return false
    const user = await database.getUser(session.platform, userId, ['authority']) as any
    return (user?.authority ?? 0) >= 4
  } catch {
    return false
  }
}

function renderStatus(enabled: boolean, scope: 'group' | 'private'): string {
  if (scope === 'group') return `本群更新推送：${enabled ? '开启' : '关闭'}`
  return `你的私聊更新推送：${enabled ? '开启' : '关闭'}`
}

async function getUserEnabled(ctx: Context, platform: string, userId: string): Promise<boolean> {
  const database = getDatabase(ctx)
  if (!database) return false
  try {
    const user = await database.getUser(platform, userId, ['mcUpdateEnabled']) as any
    return user?.mcUpdateEnabled === true
  } catch {
    return false
  }
}

async function setUserEnabled(ctx: Context, platform: string, userId: string, enabled: boolean): Promise<boolean> {
  const database = getDatabase(ctx)
  if (!database) return false
  const data = { mcUpdateEnabled: enabled }
  try {
    await database.setUser(platform, userId, data)
    return true
  } catch {
    try {
      await database.createUser(platform, userId, data)
      return true
    } catch {
      try {
        await database.setUser(platform, userId, data)
        return true
      } catch {
        return false
      }
    }
  }
}

async function getChannelEnabled(ctx: Context, platform: string, channelId: string): Promise<boolean> {
  const database = getDatabase(ctx)
  if (!database) return false
  try {
    const channel = await database.getChannel(platform, channelId, ['mcUpdateEnabled']) as any
    return channel?.mcUpdateEnabled === true
  } catch {
    return false
  }
}

async function setChannelEnabled(ctx: Context, platform: string, channelId: string, enabled: boolean): Promise<boolean> {
  const database = getDatabase(ctx)
  if (!database) return false
  const data = { mcUpdateEnabled: enabled }
  try {
    const channel = await database.getChannel(platform, channelId, ['mcUpdateEnabled']) as any
    if (channel) {
      await database.setChannel(platform, channelId, data)
      return true
    }
  } catch {}
  try {
    await database.createChannel(platform, channelId, data)
    return true
  } catch {
    try {
      await database.setChannel(platform, channelId, data)
      return true
    } catch {
      return false
    }
  }
}

async function getEnabledUserIds(ctx: Context, platform: string, userIds: string[]): Promise<Set<string>> {
  const database = getDatabase(ctx)
  if (!userIds.length || !database) return new Set()
  try {
    const bindings = await database.get('binding', { platform, pid: { $in: userIds } } as any, ['aid', 'pid']) as any[]
    if (!bindings.length) return new Set()
    const pidByAid = new Map<number, string>()
    for (const binding of bindings) pidByAid.set(binding.aid, binding.pid)
    const users = await database.get('user', {
      id: { $in: [...pidByAid.keys()] },
    } as any, ['id', 'mcUpdateEnabled']) as any[]
    const enabled = new Set<string>()
    for (const user of users) {
      if (user.mcUpdateEnabled !== true) continue
      const pid = pidByAid.get(user.id)
      if (pid) enabled.add(pid)
    }
    return enabled
  } catch {
    return new Set()
  }
}

async function getEnabledChannelIds(ctx: Context, platform: string, channelIds: string[]): Promise<Set<string>> {
  const database = getDatabase(ctx)
  if (!channelIds.length || !database) return new Set()
  try {
    const rows = await database.get('channel', {
      platform,
      id: { $in: channelIds },
    } as any, ['id', 'mcUpdateEnabled']) as any[]
    return new Set(rows.filter(row => row.mcUpdateEnabled === true).map(row => String(row.id)))
  } catch {
    return new Set()
  }
}

async function getFriends(bot: Bot): Promise<PushTarget[]> {
  const targets: PushTarget[] = []
  let next: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    let result: any
    try {
      result = await bot.getFriendList(next)
    } catch {
      break
    }
    const list = Array.isArray(result) ? result : result?.data
    if (!Array.isArray(list)) break
    for (const item of list as any[]) {
      const user = item.user ?? item
      const id = String(user.id ?? user.userId ?? user.user_id ?? '')
      if (id) targets.push({ bot, platform: bot.platform || 'unknown', id })
    }
    next = Array.isArray(result) ? undefined : result?.next
    if (!next) break
  }
  return targets
}

async function getGroups(bot: Bot): Promise<PushTarget[]> {
  const targets: PushTarget[] = []
  let next: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    let result: any
    try {
      result = await bot.getGuildList(next)
    } catch {
      break
    }
    const list = Array.isArray(result) ? result : result?.data
    if (!Array.isArray(list)) break
    for (const guild of list as any[]) {
      const id = String((guild as { channelId?: string }).channelId || guild.id || '')
      if (id) targets.push({ bot, platform: bot.platform || 'unknown', id })
    }
    next = Array.isArray(result) ? undefined : result?.next
    if (!next) break
  }
  return targets
}

async function filterTargets(ctx: Context, targets: PushTarget[], scope: 'user' | 'channel'): Promise<PushTarget[]> {
  const seen = new Set<string>()
  const unique: PushTarget[] = []
  for (const target of targets) {
    const key = `${target.platform}:${target.id}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(target)
  }
  const idsByPlatform = new Map<string, string[]>()
  for (const target of unique) {
    const ids = idsByPlatform.get(target.platform) || []
    ids.push(target.id)
    idsByPlatform.set(target.platform, ids)
  }
  const enabledByPlatform = new Map<string, Set<string>>()
  for (const [platform, ids] of idsByPlatform) {
    const enabled = scope === 'user'
      ? await getEnabledUserIds(ctx, platform, ids)
      : await getEnabledChannelIds(ctx, platform, ids)
    enabledByPlatform.set(platform, enabled)
  }
  return unique.filter(target => enabledByPlatform.get(target.platform)?.has(target.id))
}

async function collectTargets(ctx: Context): Promise<{ users: PushTarget[]; groups: PushTarget[] }> {
  const users: PushTarget[] = []
  const groups: PushTarget[] = []
  if (!hasDatabase(ctx)) return { users, groups }
  const bots = Array.from((ctx as any).bots || []) as Bot[]
  for (const bot of bots) {
    if (!bot) continue
    users.push(...await getFriends(bot))
    groups.push(...await getGroups(bot))
  }
  return {
    users: await filterTargets(ctx, users, 'user'),
    groups: await filterTargets(ctx, groups, 'channel'),
  }
}

export async function sendUpdatePush(ctx: Context, message: string): Promise<{ success: number; fail: number }> {
  let success = 0
  let fail = 0
  const logger = ctx.logger('mc-check')
  let targets: { users: PushTarget[]; groups: PushTarget[] }
  try {
    targets = await collectTargets(ctx)
  } catch (error) {
    logger.warn(`收集更新推送目标失败: ${error}`)
    return { success, fail }
  }
  for (const target of targets.groups) {
    try {
      await target.bot.sendMessage(target.id, message)
      success++
    } catch (error) {
      fail++
      logger.warn(`群聊更新推送失败: ${target.platform}:${target.id} - ${error}`)
    }
  }
  for (const target of targets.users) {
    try {
      await target.bot.sendPrivateMessage(target.id, message)
      success++
    } catch (error) {
      fail++
      logger.warn(`私聊更新推送失败: ${target.platform}:${target.id} - ${error}`)
    }
  }
  return { success, fail }
}

export function setupUpdatePush(ctx: Context, logger: Logger, getDatabaseMessage: () => string): void {
  ctx.inject(['database'], (databaseCtx) => {
    try {
      databaseCtx.model.extend('user', {
        mcUpdateEnabled: 'boolean',
      })
    } catch (error) {
      logger.warn(`扩展用户推送偏好字段失败：${error}`)
    }
    try {
      databaseCtx.model.extend('channel', {
        mcUpdateEnabled: 'boolean',
      })
    } catch (error) {
      logger.warn(`扩展群聊推送偏好字段失败：${error}`)
    }
  })

  function register(
    definition: string,
    description: string,
    aliases: string[],
    action: (argv: any) => Promise<string>,
  ): void {
    registerCommand(ctx, definition, description, (command) => {
      for (const alias of aliases) command.alias(alias)
      command.action(action)
    })
  }

  register('接收更新推送', '开启当前私聊或本群的版本更新推送', [
    '接收我的世界更新',
    '更新推送开启',
  ], async ({ session }) => {
      if (!session) return '会话不可用'
      if (!hasDatabase(ctx)) return getDatabaseMessage()
      if (session.guildId) {
        if (!await isGroupManager(ctx, session, logger)) return '只有群主或群管理员可以设置本群更新推送'
        if (!await setChannelEnabled(ctx, session.platform, (session.channelId || session.guildId)!, true)) return SETTINGS_ERROR
        return renderStatus(true, 'group')
      }
      if (!session.userId) return '会话缺少用户信息'
      if (!await setUserEnabled(ctx, session.platform, session.userId, true)) return SETTINGS_ERROR
      return renderStatus(true, 'private')
    })

  register('关闭更新推送', '关闭当前私聊或本群的版本更新推送', [
    '关闭我的世界更新',
    '更新推送关闭',
  ], async ({ session }) => {
      if (!session) return '会话不可用'
      if (!hasDatabase(ctx)) return getDatabaseMessage()
      if (session.guildId) {
        if (!await isGroupManager(ctx, session, logger)) return '只有群主或群管理员可以设置本群更新推送'
        if (!await setChannelEnabled(ctx, session.platform, (session.channelId || session.guildId)!, false)) return SETTINGS_ERROR
        return renderStatus(false, 'group')
      }
      if (!session.userId) return '会话缺少用户信息'
      if (!await setUserEnabled(ctx, session.platform, session.userId, false)) return SETTINGS_ERROR
      return renderStatus(false, 'private')
    })

  register('更新推送状态', '查看当前私聊或本群的版本更新推送状态', [
    '我的世界更新状态',
    '查看更新推送',
  ], async ({ session }) => {
      if (!session) return '会话不可用'
      if (!hasDatabase(ctx)) return getDatabaseMessage()
      if (session.guildId) {
        const enabled = await getChannelEnabled(ctx, session.platform, (session.channelId || session.guildId)!)
        return renderStatus(enabled, 'group')
      }
      if (!session.userId) return '会话缺少用户信息'
      const enabled = await getUserEnabled(ctx, session.platform, session.userId)
      return renderStatus(enabled, 'private')
    })
}
