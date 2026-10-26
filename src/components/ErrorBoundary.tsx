import { Component, type ReactNode, type ErrorInfo } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] Uncaught error:', error, info.componentStack)
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="min-h-dvh bg-red-50 flex items-center justify-center p-6">
          <div className="max-w-lg w-full bg-white border border-red-200 rounded-2xl shadow-sm p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-8 h-8 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
                    stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <h2 className="font-semibold text-red-700 text-base">Something went wrong</h2>
            </div>

            <p className="text-sm text-red-600 font-mono bg-red-50 rounded-lg p-3 break-all mb-4">
              {this.state.error.message}
            </p>

            {this.state.error.stack && (
              <details className="mb-4">
                <summary className="text-xs text-slate-500 cursor-pointer select-none mb-1">Stack trace</summary>
                <pre className="text-xs text-slate-600 bg-slate-50 rounded p-2 overflow-auto max-h-48 whitespace-pre-wrap">
                  {this.state.error.stack}
                </pre>
              </details>
            )}

            <button
              onClick={() => this.setState({ error: null })}
              className="w-full py-2 px-4 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
            >
              Try again
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
