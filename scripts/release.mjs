// One-command release: bump the patch version, compile, and publish the
// installer to the public `ai-dashboard-releases` repo so installed apps
// auto-update. The GitHub token is read from the `gh` CLI, so no secret needs
// to live in the project — just stay logged in with `gh auth login`.
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

function run(cmd, env) {
  console.log(`\n> ${cmd}`)
  execSync(cmd, { stdio: 'inherit', env: { ...process.env, ...env } })
}

// 1. Bump the patch version by editing package.json directly. (pnpm/npm version
// refuse on a dirty working tree; we intentionally don't commit build config, so
// edit the file ourselves to stay git-agnostic.)
const pkgUrl = new URL('../package.json', import.meta.url)
const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8'))
const [major, minor, patch] = pkg.version.split('.').map(Number)
pkg.version = `${major}.${minor}.${patch + 1}`
writeFileSync(pkgUrl, `${JSON.stringify(pkg, null, 2)}\n`)
console.log(`\nVersion bumped to ${pkg.version}`)

// 2. Grab a GitHub token from the gh CLI for publishing.
let token = ''
try {
  token = execSync('gh auth token').toString().trim()
} catch {
  token = ''
}
if (!token) {
  console.error('\nNo GitHub token available. Run `gh auth login` first.')
  process.exit(1)
}

// 3. Compile and publish to the releases repo.
run('pnpm run compile')
run('pnpm exec electron-builder --publish always', { GH_TOKEN: token })

console.log('\n✓ Release published. Installed apps will pick it up on the next launch.')
