export interface ServerTarget {
  address: string
  type: 'java' | 'bedrock'
}

export type PlayerEntry = string | { name?: string; name_clean?: string }

export interface ServerStatus {
  online: boolean
  host: string
  port: number
  version: string
  motd: string
  players: {
    online: number
    max: number
    list: PlayerEntry[]
  }
  ping: number | null
  icon: string | null
  software: string | null
  error: string | null
}

export interface VersionEntry {
  id: string
  releaseTime: string
}

export interface VersionInfo {
  release: VersionEntry
  snapshot: VersionEntry
}

export interface ServerAssets {
  fontPath?: string
  bgPath?: string
}