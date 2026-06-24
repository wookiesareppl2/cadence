type WindowRectangle = {
  x: number
  y: number
  width: number
  height: number
}

export type WindowDisplay = {
  workArea: WindowRectangle
}

export type PersistedWindowState = {
  bounds: WindowRectangle
  isMaximized: boolean
  isFullScreen: boolean
}

export type WindowStateSource = {
  getBounds: () => WindowRectangle
  getNormalBounds: () => WindowRectangle
  isMaximized: () => boolean
  isFullScreen: () => boolean
}

export const DEFAULT_WINDOW_BOUNDS = { width: 1440, height: 900 }
const MIN_WINDOW_SIZE = { width: 1180, height: 720 }

const MIN_VISIBLE_EDGE = 80

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function rectangleFromUnknown(value: unknown): WindowRectangle | null {
  if (typeof value !== 'object' || value === null) return null
  const source = value as Partial<WindowRectangle>
  if (
    !isFiniteNumber(source.x) ||
    !isFiniteNumber(source.y) ||
    !isFiniteNumber(source.width) ||
    !isFiniteNumber(source.height)
  ) {
    return null
  }

  return {
    x: Math.round(source.x),
    y: Math.round(source.y),
    width: Math.round(source.width),
    height: Math.round(source.height)
  }
}

function isVisibleOnAnyDisplay(bounds: WindowRectangle, displays: WindowDisplay[]): boolean {
  return displays.some(({ workArea }) => {
    const width = Math.min(bounds.x + bounds.width, workArea.x + workArea.width) - Math.max(bounds.x, workArea.x)
    const height = Math.min(bounds.y + bounds.height, workArea.y + workArea.height) - Math.max(bounds.y, workArea.y)
    return width >= MIN_VISIBLE_EDGE && height >= MIN_VISIBLE_EDGE
  })
}

export function parseWindowState(raw: string, displays: WindowDisplay[]): PersistedWindowState | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) return null
  const source = parsed as Partial<PersistedWindowState>
  const bounds = rectangleFromUnknown(source.bounds)
  if (!bounds) return null

  const normalizedBounds = {
    ...bounds,
    width: Math.max(bounds.width, MIN_WINDOW_SIZE.width),
    height: Math.max(bounds.height, MIN_WINDOW_SIZE.height)
  }

  if (displays.length > 0 && !isVisibleOnAnyDisplay(normalizedBounds, displays)) return null

  return {
    bounds: normalizedBounds,
    isMaximized: source.isMaximized === true,
    isFullScreen: source.isFullScreen === true
  }
}

export function captureWindowState(window: WindowStateSource): PersistedWindowState {
  const isMaximized = window.isMaximized()
  const isFullScreen = window.isFullScreen()
  const bounds = isMaximized || isFullScreen ? window.getNormalBounds() : window.getBounds()

  return {
    bounds,
    isMaximized,
    isFullScreen
  }
}
