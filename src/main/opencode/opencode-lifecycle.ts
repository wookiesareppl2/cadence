export class OpenCodeLifecycle<T> {
  private ensurePromise: Promise<T> | null = null
  private startController: AbortController | null = null
  private stopPromise: Promise<void> | null = null

  async ensure(start: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.stopPromise) await this.stopPromise
    if (this.ensurePromise) return this.ensurePromise

    const controller = new AbortController()
    const operation = Promise.resolve().then(() => start(controller.signal))
    this.startController = controller
    this.ensurePromise = operation

    try {
      return await operation
    } finally {
      if (this.ensurePromise === operation) this.ensurePromise = null
      if (this.startController === controller) this.startController = null
    }
  }

  async stop(stop: () => Promise<void>): Promise<void> {
    if (this.stopPromise) return this.stopPromise

    this.startController?.abort(new Error('OpenCode runtime startup stopped'))
    const pendingStart = this.ensurePromise
    const operation = (async () => {
      await stop()
      await pendingStart?.catch(() => undefined)
    })()
    this.stopPromise = operation

    try {
      await operation
    } finally {
      if (this.stopPromise === operation) this.stopPromise = null
    }
  }
}
