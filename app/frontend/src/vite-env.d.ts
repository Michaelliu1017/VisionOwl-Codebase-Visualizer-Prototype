/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_USE_MOCK?: string
  readonly VITE_API_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

interface DwsProfile {
  profile: string
  corpId: string
  corpName: string
  userId: string
  userName: string
  status: string
  isCurrent: boolean
}

interface DwsStatus {
  available: boolean
  authenticated: boolean
  message: string
  currentProfile: string | null
  profiles: DwsProfile[]
}

interface Window {
  visionowl: {
    platform: string
    versions: { electron: string; chrome: string }
    dws: {
      status: () => Promise<DwsStatus>
      login: () => Promise<DwsStatus>
      switchProfile: (profile: string) => Promise<DwsStatus>
      logoutProfile: (profile: string) => Promise<DwsStatus>
      publish: (input: {
        profile: string
        title: string
        markdown: string
        existingNodeId?: string | null
        workspaceId?: string | null
        folderId?: string | null
      }) => Promise<{ nodeId: string; url: string }>
    }
  }
}
