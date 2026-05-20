import type { DashboardApi } from '../../preload'

declare global {
  interface Window {
    dashboard: DashboardApi
  }
}

export {}
