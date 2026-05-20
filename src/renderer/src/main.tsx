import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import './styles.css'

type RendererErrorBoundaryState = {
  error: Error | null
}

class RendererErrorBoundary extends React.Component<React.PropsWithChildren, RendererErrorBoundaryState> {
  state: RendererErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): RendererErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error): void {
    console.error('Renderer crashed', error)
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <main className="renderer-failure">
          <h1>Renderer error</h1>
          <pre>{this.state.error.message}</pre>
        </main>
      )
    }

    return this.props.children
  }
}

window.addEventListener('error', (event) => {
  console.error('Uncaught renderer error', event.error ?? event.message)
})

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled renderer rejection', event.reason)
})

const root = document.getElementById('root')

if (!root) {
  throw new Error('Renderer root element was not found')
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <RendererErrorBoundary>
      <App />
    </RendererErrorBoundary>
  </React.StrictMode>
)
