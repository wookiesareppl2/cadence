import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const aliases = {
  '@renderer': resolve('src/renderer/src'),
  '@platforms': resolve('src/platforms'),
  '@shared': resolve('src/shared')
}

export default defineConfig({
  main: {
    resolve: {
      alias: aliases
    },
    // Bundle electron-updater (and its transitive deps such as debug/ms) into the
    // main bundle. pnpm + electron-builder otherwise drop deep transitive deps
    // from the packaged node_modules (e.g. `ms`), which crashes the packaged main
    // process at startup with "Cannot find module 'ms'".
    plugins: [externalizeDepsPlugin({ exclude: ['electron-updater'] })]
  },
  preload: {
    resolve: {
      alias: aliases
    },
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: {
      alias: aliases
    },
    plugins: [react()]
  }
})
