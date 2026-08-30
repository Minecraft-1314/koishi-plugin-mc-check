import net from 'node:net'
import path from 'node:path'
import fs from 'node:fs'
import type { PlayerEntry, ServerStatus } from './types'

export function parseHostPort(raw: string, defaultPort: number): { host: string; port: number } {
  const match = raw.match(/^(.+):(\d{1,5})$/)
  if (match) {
    const port = Number(match[2])
    if (port >= 1 && port <= 65535) return { host: match[1], port }
  }
  return { host: raw, port: defaultPort }
}

export function parseTime(timeStr: string): { hour: number; minute: number } {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(timeStr)
  if (!match) return { hour: 9, minute: 0 }
  return { hour: Number(match[1]), minute: Number(match[2]) }
}

export function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function tcpPing(host: string, port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const start = Date.now()
    const socket = new net.Socket()
    let settled = false
    const done = (value: number | null) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(3000)
    socket.once('connect', () => done(Date.now() - start))
    socket.once('error', () => done(null))
    socket.once('timeout', () => done(null))
    socket.connect(port, host)
  })
}

export async function toDataUri(filePath: string): Promise<string> {
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

function playerName(player: PlayerEntry): string {
  return typeof player === 'string' ? player : (player.name || player.name_clean || '未知玩家')
}

export function formatStatus(status: ServerStatus, label: string): string {
  if (!status.online) {
    const suffix = status.error ? ` (${escapeHtml(status.error)})` : ''
    return `❌ ${escapeHtml(label)} - 离线${suffix}`
  }
  const shown = status.players.list.slice(0, 20)
  const onlineText = status.players.online && shown.length
    ? `\n  在线: ${shown.map(playerName).map(escapeHtml).join(', ')}${status.players.list.length > 20 ? ' 等' : ''}`
    : ''
  const pingText = status.ping !== null ? `  📶 ${status.ping}ms` : ''
  const softwareText = status.software ? `\n⚙️ 服务端: ${escapeHtml(status.software)}` : ''
  return [
    `🟢 ${escapeHtml(label)}:${status.port}${pingText}`,
    `📋 版本: ${escapeHtml(status.version)}`,
    `👥 玩家: ${status.players.online}/${status.players.max}${onlineText}`,
    status.motd ? `💬 MOTD: ${escapeHtml(status.motd)}` : '',
    softwareText,
  ].filter(Boolean).join('\n')
}