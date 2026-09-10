import { create } from 'zustand'
import type { DingtalkConnection } from '../api/types'

interface Destination {
  workspaceId: string | null
  folderId: string | null
}

interface DingtalkState {
  loaded: boolean
  open: boolean
  connections: DingtalkConnection[]
  busy: boolean
  authenticating: boolean
  error: string | null
  bootstrap: () => Promise<void>
  openSettings: () => void
  closeSettings: () => void
  startConnect: () => Promise<void>
  select: (profile: string) => Promise<void>
  saveDestination: (profile: string, workspaceId: string, folderId: string) => Promise<void>
  remove: (profile: string) => Promise<void>
  reportError: (message: string) => void
  reset: () => void
}

const DESTINATIONS_KEY = 'visionowl.dingtalk.destinations'
let generation = 0

function destinations(): Record<string, Destination> {
  try {
    return JSON.parse(localStorage.getItem(DESTINATIONS_KEY) ?? '{}') as Record<string, Destination>
  } catch {
    return {}
  }
}

function saveDestinations(value: Record<string, Destination>): void {
  localStorage.setItem(DESTINATIONS_KEY, JSON.stringify(value))
}

function connectionsFromStatus(status: DwsStatus): DingtalkConnection[] {
  const saved = destinations()
  const timestamp = new Date().toISOString()
  return status.profiles.map(profile => ({
    id: profile.profile,
    profileKey: profile.profile,
    corpId: profile.corpId,
    corpName: profile.corpName,
    userId: profile.userId,
    userName: profile.userName,
    status: profile.status === 'active' ? 'active' : 'reauth_required',
    isDefault: profile.isCurrent || status.currentProfile === profile.profile,
    workspaceId: saved[profile.profile]?.workspaceId ?? null,
    folderId: saved[profile.profile]?.folderId ?? null,
    lastVerifiedAt: status.authenticated && (profile.isCurrent || status.currentProfile === profile.profile)
      ? timestamp
      : null,
    createdAt: timestamp,
    updatedAt: timestamp
  }))
}

function hasActiveConnection(connections: DingtalkConnection[]): boolean {
  return connections.some(connection => connection.status === 'active' && connection.isDefault)
}

export const useDingtalk = create<DingtalkState>((set, get) => ({
  loaded: false,
  open: false,
  connections: [],
  busy: false,
  authenticating: false,
  error: null,

  async bootstrap() {
    const currentGeneration = ++generation
    set({ loaded: false, error: null })
    if (!window.visionowl?.dws) {
      set({ loaded: true, open: false, connections: [], error: null })
      return
    }
    try {
      const status = await window.visionowl.dws.status()
      if (currentGeneration !== generation) return
      const connections = connectionsFromStatus(status)
      const configured = status.authenticated && hasActiveConnection(connections)
      set({
        loaded: true,
        connections,
        open: !configured,
        error: status.available ? null : status.message
      })
    } catch (error) {
      if (currentGeneration !== generation) return
      set({ loaded: true, open: true, error: error instanceof Error ? error.message : '本机 DWS 配置加载失败' })
    }
  },

  openSettings() {
    set({ open: true, error: null })
  },

  closeSettings() {
    if (!hasActiveConnection(get().connections)) return
    set({ open: false, error: null })
  },

  async startConnect() {
    if (get().busy) return
    const currentGeneration = ++generation
    set({ busy: true, authenticating: true, error: null })
    try {
      const status = await window.visionowl.dws.login()
      if (currentGeneration !== generation) return
      const connections = connectionsFromStatus(status)
      if (!status.authenticated || !hasActiveConnection(connections)) {
        throw new Error('钉钉登录成功，但未读取到可用身份')
      }
      set({ connections, busy: false, authenticating: false, error: null })
    } catch (error) {
      if (currentGeneration !== generation) return
      set({ busy: false, authenticating: false, error: error instanceof Error ? error.message : '钉钉授权失败' })
    }
  },

  async select(profile) {
    set({ busy: true, error: null })
    try {
      const status = await window.visionowl.dws.switchProfile(profile)
      set({ connections: connectionsFromStatus(status), busy: false })
    } catch (error) {
      set({ busy: false, error: error instanceof Error ? error.message : '身份切换失败' })
    }
  },

  async saveDestination(profile, workspaceId, folderId) {
    const saved = destinations()
    saved[profile] = {
      workspaceId: workspaceId.trim() || null,
      folderId: folderId.trim() || null
    }
    saveDestinations(saved)
    set(state => ({
      connections: state.connections.map(connection => connection.profileKey === profile
        ? { ...connection, ...saved[profile], updatedAt: new Date().toISOString() }
        : connection),
      error: null
    }))
  },

  async remove(profile) {
    set({ busy: true, error: null })
    try {
      const status = await window.visionowl.dws.logoutProfile(profile)
      const saved = destinations()
      delete saved[profile]
      saveDestinations(saved)
      const connections = connectionsFromStatus(status)
      set({ connections, busy: false, open: !status.authenticated || !hasActiveConnection(connections) })
    } catch (error) {
      set({ busy: false, error: error instanceof Error ? error.message : '身份解绑失败' })
    }
  },

  reportError(message) {
    set({ open: true, error: message })
  },

  reset() {
    generation += 1
    set({ loaded: false, open: false, connections: [], busy: false, authenticating: false, error: null })
  }
}))
