import { useState } from 'react'
import { isMockApi } from '../api/client'
import { useSession } from '../stores/session'

export function Login() {
  const login = useSession(s => s.login)
  const pending = useSession(s => s.pending)
  const error = useSession(s => s.error)
  const [email, setEmail] = useState('owner@demo.dev')
  const [password, setPassword] = useState('demo1234')

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    void login(email, password)
  }

  return (
    <div className="vo-login">
      <form className="vo-login__card" onSubmit={submit}>
        <img className="vo-login__logo" src="./hackowl-transparent.png" alt="VisionOwl" />
        <h1>VisionOwl</h1>
        <p>面向研发团队的云端代码知识平台</p>
        <label>
          <span>邮箱</span>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label>
          <span>密码</span>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && <div className="vo-login__error">{error}</div>}
        <button type="submit" disabled={pending}>
          {pending ? '登录中…' : '登录'}
        </button>
        <div className="vo-login__hint">
          {isMockApi ? 'Mock 模式' : '云端模式'} · owner@demo.dev / demo1234
        </div>
      </form>
    </div>
  )
}
