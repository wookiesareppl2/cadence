import { describe, expect, it } from 'vitest'
import { captureWindowState, parseWindowState, type WindowDisplay } from '../src/main/window-state-utils'

const displays: WindowDisplay[] = [
  {
    workArea: {
      x: 0,
      y: 0,
      width: 1920,
      height: 1080
    }
  }
]

describe('parseWindowState', () => {
  it('restores valid bounds and window state flags', () => {
    const state = parseWindowState(
      JSON.stringify({
        bounds: { x: 120, y: 80, width: 1500, height: 920 },
        isMaximized: true,
        isFullScreen: false
      }),
      displays
    )

    expect(state).toEqual({
      bounds: { x: 120, y: 80, width: 1500, height: 920 },
      isMaximized: true,
      isFullScreen: false
    })
  })

  it('rejects stale bounds that are no longer visible on any display', () => {
    const state = parseWindowState(
      JSON.stringify({
        bounds: { x: 9000, y: 9000, width: 1440, height: 900 },
        isMaximized: false,
        isFullScreen: false
      }),
      displays
    )

    expect(state).toBeNull()
  })

  it('clamps restored bounds to the app minimum size', () => {
    const state = parseWindowState(
      JSON.stringify({
        bounds: { x: 50, y: 50, width: 640, height: 480 },
        isMaximized: false,
        isFullScreen: false
      }),
      displays
    )

    expect(state?.bounds).toEqual({ x: 50, y: 50, width: 1180, height: 720 })
  })
})

describe('captureWindowState', () => {
  it('stores normal bounds when the window is maximized', () => {
    const state = captureWindowState({
      getBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
      getNormalBounds: () => ({ x: 220, y: 120, width: 1440, height: 900 }),
      isMaximized: () => true,
      isFullScreen: () => false
    })

    expect(state).toEqual({
      bounds: { x: 220, y: 120, width: 1440, height: 900 },
      isMaximized: true,
      isFullScreen: false
    })
  })
})
