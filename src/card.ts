import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { escapeHtml, toDataUri } from './utils'
import type { ServerAssets, ServerStatus } from './types'

function fileUrl(filePath: string): string {
  return pathToFileURL(filePath).href
}

async function buildTemplate(assets: ServerAssets, inline: boolean): Promise<string> {
  const font = assets.fontPath
    ? `@font-face{font-family:'MinecraftFont';src:url('${inline ? await toDataUri(assets.fontPath) : fileUrl(assets.fontPath)}');}`
    : ''
  const fontFamily = assets.fontPath
    ? "'MinecraftFont','Segoe UI',Tahoma,Geneva,Verdana,sans-serif"
    : "'Segoe UI',Tahoma,Geneva,Verdana,sans-serif"
  const bgStyle = assets.bgPath
    ? `background-image:url('${inline ? await toDataUri(assets.bgPath) : fileUrl(assets.bgPath)}');background-size:cover;background-position:center;`
    : 'background:#1e1e1e;'
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${font}body{margin:0;padding:30px;font-family:${fontFamily};${bgStyle}color:white;display:flex;justify-content:center;align-items:center;min-height:100vh;}.card{background:rgba(30,30,30,0.85);border-radius:20px;padding:30px;box-shadow:0 10px 30px rgba(0,0,0,0.5);width:500px;border:1px solid #444;}.header{display:flex;align-items:center;margin-bottom:20px;}.info{flex:1;}.hostname{font-size:28px;font-weight:bold;margin-bottom:5px;}.version{font-size:18px;color:#aaa;}.status{font-size:20px;font-weight:bold;text-align:right;}.players{background:#444;border-radius:10px;padding:15px;margin:15px 0;display:flex;justify-content:space-between;font-size:22px;}.motd{background:#333;border-radius:10px;padding:15px;margin:15px 0;font-size:18px;line-height:1.5;color:#ddd;}.details{display:flex;gap:20px;font-size:16px;color:#aaa;}.ping{color:#8BC34A;font-weight:bold;}</style></head><body><div class="card"><div class="header"><img id="icon" style="width:64px;height:64px;border-radius:8px;margin-right:16px;display:none;"><div class="info"><div id="hostname" class="hostname"></div><div id="version" class="version"></div></div><div id="status" class="status"></div></div><div class="players"><span id="players"></span><span id="rate"></span></div><div id="motd" class="motd" style="display:none;"></div><div id="details" class="details"></div></div></body></html>`
}

function buildDetailsHtml(status: ServerStatus): string {
  let html = ''
  if (status.software) html += `<span>⚙️ ${escapeHtml(status.software)}</span>`
  if (status.ping) html += `<span class="ping">📶 ${status.ping}ms</span>`
  return html
}

let templateFile = ''

export async function renderStatusCard(
  puppeteer: any,
  status: ServerStatus,
  label: string,
  assets: ServerAssets,
): Promise<Buffer | null> {
  let page: any
  try {
    page = await puppeteer.page()
    await page.setViewport({ width: 600, height: 400, deviceScaleFactor: 1 })
    try {
      if (!templateFile) {
        templateFile = path.join(os.tmpdir(), `koishi-mc-card-${process.pid}.html`)
        await fs.promises.writeFile(templateFile, await buildTemplate(assets, false))
      }
      await page.goto(fileUrl(templateFile))
    } catch {
      await page.setContent(await buildTemplate(assets, true))
    }
    await page.evaluate((data: any) => {
      const el = (id: string) => (globalThis as any).document.getElementById(id)
      const icon = el('icon')
      if (icon) {
        if (data.icon) {
          icon.src = data.icon
          icon.style.display = ''
        } else {
          icon.style.display = 'none'
        }
      }
      const hostname = el('hostname')
      if (hostname) hostname.textContent = data.host
      const version = el('version')
      if (version) version.textContent = `版本: ${data.version}`
      const statusEl = el('status')
      if (statusEl) {
        statusEl.textContent = data.online ? '在线' : '离线'
        statusEl.style.color = data.online ? '#4CAF50' : '#F44336'
      }
      const players = el('players')
      if (players) players.textContent = `👥 ${data.playerOnline}/${data.playerMax}`
      const rate = el('rate')
      if (rate) rate.textContent = `🟢 在线率 ${data.rate}%`
      const motd = el('motd')
      if (motd) {
        if (data.motd) {
          motd.textContent = data.motd
          motd.style.display = ''
        } else {
          motd.style.display = 'none'
        }
      }
      const details = el('details')
      if (details) details.innerHTML = data.detailsHtml
    }, {
      host: label,
      version: status.version,
      online: status.online,
      playerOnline: status.players.online,
      playerMax: status.players.max,
      rate: status.players.max > 0 ? Math.round((status.players.online / status.players.max) * 100) : 0,
      motd: status.motd,
      icon: status.icon,
      detailsHtml: buildDetailsHtml(status),
    })
    if (typeof page.waitForNetworkIdle === 'function') {
      await page.waitForNetworkIdle({ idleTime: 500 }).catch(() => page.waitForTimeout(500))
    } else {
      await page.waitForTimeout(500)
    }
    const image = await page.screenshot({ type: 'jpeg', quality: 90, fullPage: true })
    return image as Buffer
  } catch {
    return null
  } finally {
    if (page) await page.close().catch(() => {})
  }
}