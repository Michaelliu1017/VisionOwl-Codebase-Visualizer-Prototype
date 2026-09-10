import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[visionowl] 页面渲染失败:', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <main className="vo-fatal-error">
        <strong>页面加载失败</strong>
        <p>{this.state.error.message}</p>
        <button type="button" onClick={() => window.location.reload()}>重新加载</button>
      </main>
    )
  }
}
