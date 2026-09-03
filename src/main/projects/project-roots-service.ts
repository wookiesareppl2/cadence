import { dialog, type BrowserWindow } from 'electron'
import { makeProjectRoot, parseWslSharePath, type ProjectRoot } from '@shared/project-roots'

// Choose a folder that projects live inside.
//
// One picker serves both origins. Windows exposes each running WSL distro under
// `\wsl.localhost\<distro>` (the "Linux" entry in Explorer's sidebar), so a user
// can browse into Ubuntu from the ordinary folder dialog; a path that comes back on
// that share is turned into the distro + POSIX path the rest of the app speaks,
// rather than being stored as a UNC path that only resolves while the distro is
// running.
export async function pickProjectRoot(window: BrowserWindow | null): Promise<ProjectRoot | null> {
  const options: Electron.OpenDialogOptions = {
    title: 'Choose a folder your projects live in',
    buttonLabel: 'Use this folder',
    message: 'Pick the folder that CONTAINS your projects. For WSL, open Linux in the sidebar.',
    properties: ['openDirectory']
  }

  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return null

  const picked = result.filePaths[0]
  const wsl = parseWslSharePath(picked)
  return wsl ? makeProjectRoot(wsl.posixPath, wsl.distro) : makeProjectRoot(picked, null)
}
