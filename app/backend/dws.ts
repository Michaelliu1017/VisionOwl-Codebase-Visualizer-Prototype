import { app } from 'electron'
import { spawn } from 'node:child_process'
import { constants, existsSync } from 'node:fs'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export interface DwsProfile {
  profile: string
  corpId: string
  corpName: string
  userId: string
  userName: string
  status: string
  isCurrent: boolean
}

export interface DwsStatus {
  available: boolean
  authenticated: boolean
  message: string
  currentProfile: string | null
  profiles: DwsProfile[]
}

export interface DwsPublishInput {
  profile: string
  title: string
  markdown: string
  existingNodeId?: string | null
  workspaceId?: string | null
  folderId?: string | null
}

export interface DwsPublishResult {
  nodeId: string
  url: string
}

interface DwsRunOptions {
  timeoutMs?: number
}

const DWS_AUTH_TIMEOUT_MS = 10 * 60 * 1000
const DWS_COMMAND_TIMEOUT_MS = 3 * 60 * 1000
let loginInFlight: Promise<DwsStatus> | null = null

function packagedBinary(): string {
  return join(
    app.getAppPath(),
    'node_modules',
    'dingtalk-workspace-cli',
    'vendor',
    process.platform === 'win32' ? 'dws.exe' : 'dws'
  )
}

function dwsCandidates(): string[] {
  const executable = process.platform === 'win32' ? 'dws.exe' : 'dws'
  return [
    process.env.DWS_BIN ?? '',
    packagedBinary(),
    join(process.cwd(), 'node_modules', 'dingtalk-workspace-cli', 'vendor', executable),
    join(__dirname, '..', '..', 'node_modules', 'dingtalk-workspace-cli', 'vendor', executable),
    join(homedir(), '.qoderwork', 'bin', executable),
    join(homedir(), '.real', '.bin', 'dws', 'bin', executable),
    'dws'
  ].filter(Boolean)
}

async function dwsBinary(): Promise<string> {
  for (const candidate of dwsCandidates()) {
    if (candidate === 'dws') return candidate
    if (!existsSync(candidate)) continue
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      continue
    }
  }
  return 'dws'
}

function cleanError(value: string): string {
  return value
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/(access|refresh)[_-]?token["'=:\s]+[^\s",}]+/gi, '$1_token=***')
    .trim()
}

function actionableDwsError(value: string): string {
  const cleaned = cleanError(value)
  if (/ENTERPRISE_NOT_AUTHORIZED/i.test(cleaned)) {
    return '当前钉钉企业未授权 DWS 创建文档（ENTERPRISE_NOT_AUTHORIZED）。登录成功只代表身份有效，请切换到已授权的企业身份；若必须使用当前企业，请联系企业管理员开通文档写入授权后重试。'
  }
  return cleaned
}

async function runDws(args: string[], options: DwsRunOptions = {}): Promise<string> {
  const binary = await dwsBinary()
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      finish(new Error('DWS 操作超时，请重试'))
    }, options.timeoutMs ?? DWS_COMMAND_TIMEOUT_MS)

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(error)
      else resolve(stdout.trim())
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', error => {
      finish(new Error((error as NodeJS.ErrnoException).code === 'ENOENT'
        ? '未找到 DWS CLI，请重新安装桌面应用'
        : error.message))
    })
    child.on('close', code => {
      if (code === 0) finish()
      else finish(new Error(actionableDwsError(stderr || stdout) || `DWS 退出码 ${code ?? 'unknown'}`))
    })
  })
}

function parseJson(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
  } catch {
    const start = raw.indexOf('{')
    if (start < 0) return null
    try {
      const value = JSON.parse(raw.slice(start)) as unknown
      return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
    } catch {
      return null
    }
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function deepString(value: unknown, keys: Set<string>): string | null {
  if (!value || typeof value !== 'object') return null
  for (const [key, nested] of Object.entries(value)) {
    if (keys.has(key)) {
      const found = stringValue(nested)
      if (found) return found
    }
  }
  for (const nested of Object.values(value)) {
    const found = deepString(nested, keys)
    if (found) return found
  }
  return null
}

async function profileList(): Promise<{ currentProfile: string | null; profiles: DwsProfile[] }> {
  const payload = parseJson(await runDws(['profile', 'list', '--format', 'json']))
  const profiles = Array.isArray(payload?.profiles) ? payload.profiles : []
  return {
    currentProfile: stringValue(payload?.currentProfile) || null,
    profiles: profiles.flatMap(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return []
      const profile = item as Record<string, unknown>
      const selector = stringValue(profile.profile)
      if (!selector) return []
      return [{
        profile: selector,
        corpId: stringValue(profile.corpId),
        corpName: stringValue(profile.corpName),
        userId: stringValue(profile.userId),
        userName: stringValue(profile.userName),
        status: stringValue(profile.status) || 'active',
        isCurrent: profile.isCurrent === true
      }]
    })
  }
}

export async function getDwsStatus(): Promise<DwsStatus> {
  try {
    const status = parseJson(await runDws(['auth', 'status', '--format', 'json'])) ?? {}
    const list = await profileList().catch((): { currentProfile: string | null; profiles: DwsProfile[] } => ({
      currentProfile: null,
      profiles: []
    }))
    if (status.authenticated === true && list.profiles.length === 0) {
      const corpId = stringValue(status.corp_id ?? status.corpId)
      const userId = stringValue(status.user_id ?? status.userId)
      const profile = [corpId, userId].filter(Boolean).join(':')
      if (profile) {
        list.currentProfile = profile
        list.profiles.push({
          profile,
          corpId,
          corpName: stringValue(status.corp_name ?? status.corpName),
          userId,
          userName: stringValue(status.user_name ?? status.userName),
          status: 'active',
          isCurrent: true
        })
      }
    }
    return {
      available: true,
      authenticated: status.authenticated === true,
      message: stringValue(status.message) || (status.authenticated === true ? '已登录' : '未登录'),
      currentProfile: list.currentProfile,
      profiles: list.profiles
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const unavailable = /未找到 DWS|ENOENT|not found/i.test(message)
    return {
      available: !unavailable,
      authenticated: false,
      message,
      currentProfile: null,
      profiles: []
    }
  }
}

export function loginDws(): Promise<DwsStatus> {
  if (loginInFlight) return loginInFlight
  loginInFlight = (async () => {
    await runDws(['auth', 'login', '--recommend'], { timeoutMs: DWS_AUTH_TIMEOUT_MS })
    const status = await getDwsStatus()
    if (!status.authenticated) throw new Error('钉钉授权未完成，请重新扫码登录')
    return status
  })().finally(() => { loginInFlight = null })
  return loginInFlight
}

export async function switchDwsProfile(profile: string): Promise<DwsStatus> {
  if (!profile.trim()) throw new Error('钉钉身份不能为空')
  await runDws(['profile', 'switch', profile, '--format', 'json'])
  return getDwsStatus()
}

export async function logoutDwsProfile(profile: string): Promise<DwsStatus> {
  if (!profile.trim()) throw new Error('钉钉身份不能为空')
  await runDws(['auth', 'logout', '--profile', profile])
  return getDwsStatus()
}

export async function publishDwsDocument(input: DwsPublishInput): Promise<DwsPublishResult> {
  const title = input.title.trim()
  const profile = input.profile.trim()
  if (!profile) throw new Error('请先选择钉钉身份')
  if (!title) throw new Error('文档标题不能为空')
  if (!input.markdown.trim()) throw new Error('文档内容不能为空')
  if (input.markdown.length > 2_000_000) throw new Error('文档内容过大，暂不支持发布')

  const root = await mkdtemp(join(tmpdir(), 'visionowl-dingtalk-'))
  const markdownFile = join(root, 'document.md')
  await writeFile(markdownFile, input.markdown, 'utf8')
  try {
    let nodeId = input.existingNodeId?.trim() || ''
    if (nodeId) {
      await runDws([
        '--profile', profile, '--format', 'json', '--yes',
        'doc', 'update', '--node', nodeId, '--content-file', markdownFile, '--mode', 'overwrite'
      ])
    } else {
      const args = [
        '--profile', profile, '--format', 'json', '--yes',
        'doc', 'create', '--name', title, '--content-file', markdownFile
      ]
      if (input.folderId?.trim()) args.push('--folder', input.folderId.trim())
      else if (input.workspaceId?.trim()) args.push('--workspace', input.workspaceId.trim())
      const created = parseJson(await runDws(args)) ?? {}
      nodeId = deepString(created, new Set(['nodeId', 'node_id', 'uuid', 'id'])) ?? ''
      if (!nodeId) throw new Error('钉钉文档已创建，但 DWS 未返回 nodeId')
    }

    await runDws([
      '--profile', profile,
      'doc', 'read', '--node', nodeId, '--format', 'raw'
    ])
    return {
      nodeId,
      url: `https://alidocs.dingtalk.com/i/nodes/${encodeURIComponent(nodeId)}`
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}
