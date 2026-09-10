import { create } from 'zustand'
import { api, setToken } from '../api/client'
import type { User } from '../api/types'

interface SessionState {
  user: User | null
  pending: boolean
  error: string | null
  login: (email: string, password: string) => Promise<boolean>
  logout: () => void
}

export const useSession = create<SessionState>(set => ({
  user: null,
  pending: false,
  error: null,

  async login(email, password) {
    set({ pending: true, error: null })
    try {
      const res = await api.login(email, password)
      setToken(res.token)
      set({ user: res.user, pending: false })
      return true
    } catch (e) {
      set({ pending: false, error: e instanceof Error ? e.message : '登录失败' })
      return false
    }
  },

  logout() {
    setToken(null)
    set({ user: null })
  }
}))
