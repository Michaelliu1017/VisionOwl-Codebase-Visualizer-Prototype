import { useProject } from '../../stores/project'
import { useSession } from '../../stores/session'

export function StatusBar() {
  const graphVersion = useProject(s => s.graphVersion)
  const project = useProject(s => s.project)
  const job = useProject(s => s.job)
  const eventConnected = useProject(s => s.eventConnected)
  const user = useSession(s => s.user)

  // 数据来源随 VITE_USE_MOCK 变化,状态栏必须如实反映,不能写死
  const usingMock = import.meta.env.VITE_USE_MOCK !== '0'
  const source = usingMock
    ? 'Mock'
    : (import.meta.env.VITE_API_BASE ?? '').replace(/^https?:\/\//, '') || '云端'

  return (
    <footer className="vo-statusbar">
      <span>
        <i className="vo-dot" /> 已连接({source}) · 实时事件: {usingMock ? 'Mock' : eventConnected ? '在线' : '重连中'} · 图谱 v{graphVersion?.versionNo ?? '—'} 对应{' '}
        <code>{graphVersion?.commitSha ?? '—'}</code> · 分析队列: {job?.status === 'queued' || job?.status === 'running' ? job.status : '空闲'}
      </span>
      <span>
        {user?.name} · 角色: {project?.myRole ?? '—'}
      </span>
    </footer>
  )
}
