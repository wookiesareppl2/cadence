import { describe, expect, it, vi } from 'vitest'
import { OpenCodeLifecycle } from '../src/main/opencode/opencode-lifecycle'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('OpenCode runtime lifecycle', () => {
  it('shares one startup across concurrent callers', async () => {
    const lifecycle = new OpenCodeLifecycle<string>()
    const startup = deferred<string>()
    const start = vi.fn(() => startup.promise)

    const requests = [lifecycle.ensure(start), lifecycle.ensure(start), lifecycle.ensure(start)]
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1))
    startup.resolve('ready')

    await expect(Promise.all(requests)).resolves.toEqual(['ready', 'ready', 'ready'])
  })

  it('clears a failed startup so the next caller can retry', async () => {
    const lifecycle = new OpenCodeLifecycle<string>()
    const start = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockRejectedValueOnce(new Error('failed'))
      .mockResolvedValueOnce('ready')

    await expect(lifecycle.ensure(start)).rejects.toThrow('failed')
    await expect(lifecycle.ensure(start)).resolves.toBe('ready')
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('cancels an in-flight startup before allowing a replacement', async () => {
    const lifecycle = new OpenCodeLifecycle<string>()
    const stopped = deferred<void>()
    const firstStart = vi.fn((signal: AbortSignal) => {
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    const firstRequest = lifecycle.ensure(firstStart)
    await vi.waitFor(() => expect(firstStart).toHaveBeenCalledTimes(1))

    const stop = vi.fn(() => stopped.promise)
    const stopRequest = lifecycle.stop(stop)
    expect(firstStart.mock.calls[0]?.[0].aborted).toBe(true)
    await expect(firstRequest).rejects.toThrow('OpenCode runtime startup stopped')

    const replacement = lifecycle.ensure(async () => 'replacement')
    expect(stop).toHaveBeenCalledTimes(1)
    stopped.resolve()
    await expect(stopRequest).resolves.toBeUndefined()
    await expect(replacement).resolves.toBe('replacement')
  })
})
