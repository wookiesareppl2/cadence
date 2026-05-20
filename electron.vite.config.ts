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
    plugins: [externalizeDepsPlugin()]
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
