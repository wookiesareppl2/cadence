import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@platforms': resolve('src/platforms'),
      '@shared': resolve('src/shared')
    }
  },
  test: {
    // Node by default: almost every test here is pure logic, and a DOM for all of
    // them would be slower for no gain. A test that genuinely needs one opts in
    // per file with a `@vitest-environment jsdom` docblock at the top.
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx']
  }
})
