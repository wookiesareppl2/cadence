import { describe, expect, it } from 'vitest'
import {
  isInsideProjectRoots,
  makeProjectRoot,
  parseWslSharePath,
  rollUpToProjectFolder
} from '../src/shared/project-roots'

// Project roots decide two things at once: whether a discovered folder is a project
// at all, and which folder a session run deep inside one belongs to. Both answers
// change what the user sees in the Projects list, and a wrong one either hides real
// work or splits one project across several entries.

const win = makeProjectRoot('C:\\Code', null)
const winNested = makeProjectRoot('C:\\Code\\Clients', null)
const wsl = makeProjectRoot('/home/sheldon/code', 'Ubuntu')

// A single backslash inside a JS string literal is an escape, so a Windows fixture
// written with one silently becomes a path with no separators at all - and every
// assertion still passes, because both sides are mangled the same way. This checks
// the fixtures are real paths before anything is asserted about them.
describe('the Windows fixtures are actually Windows paths', () => {
  it('contains real separators, not swallowed escapes', () => {
    const separator = String.fromCharCode(92)
    expect(win.path).toBe('C:' + separator + 'Code')
    expect(winNested.path.split(separator)).toHaveLength(3)
    expect(win.path.length).toBe(7)
  })
})

describe('with no roots configured', () => {
  // The safe default. An app that has never been configured must behave exactly as
  // it did before rather than presenting an empty Projects list.
  it('accepts every path unchanged', () => {
    expect(rollUpToProjectFolder('C:\\anywhere\\at\\all', null, [])).toBe('C:\\anywhere\\at\\all')
    expect(rollUpToProjectFolder('/tmp/scratch', 'Ubuntu', [])).toBe('/tmp/scratch')
    expect(isInsideProjectRoots('C:\\whatever', null, [])).toBe(true)
  })
})

describe('rolling a session cwd up to its project folder', () => {
  it('treats a folder directly inside a root as the project', () => {
    expect(rollUpToProjectFolder('C:\\Code\\cadence', null, [win])).toBe('C:\\Code\\cadence')
  })

  it('rolls a session run deeper up to that same folder', () => {
    expect(rollUpToProjectFolder('C:\\Code\\cadence\\src\\renderer', null, [win])).toBe(
      'C:\\Code\\cadence'
    )
  })

  // Otherwise a session started in the root itself would be discarded, even though
  // the user pointed at that folder on purpose.
  it('treats the root itself as a project when a session ran there', () => {
    expect(rollUpToProjectFolder('C:\\Code', null, [win])).toBe('C:\\Code')
  })

  it('rejects a path outside every root', () => {
    expect(rollUpToProjectFolder('C:\\Users\\sheldon\\Downloads', null, [win])).toBeNull()
    expect(isInsideProjectRoots('C:\\Users\\sheldon\\Downloads', null, [win])).toBe(false)
  })

  // A prefix match on the raw string would wrongly accept this: "C:\CodeReview"
  // starts with "C:\Code". Matching whole segments is what makes it a real folder
  // boundary rather than a text prefix.
  it('does not mistake a sibling folder with a shared prefix for a child', () => {
    expect(rollUpToProjectFolder('C:\\CodeReview\\thing', null, [win])).toBeNull()
  })

  it('resolves against the most specific root when roots nest', () => {
    const roots = [win, winNested]
    expect(rollUpToProjectFolder('C:\\Code\\Clients\\acme\\src', null, roots)).toBe(
      'C:\\Code\\Clients\\acme'
    )
    // Order must not decide it.
    expect(rollUpToProjectFolder('C:\\Code\\Clients\\acme\\src', null, [winNested, win])).toBe(
      'C:\\Code\\Clients\\acme'
    )
  })
})

describe('Windows and WSL are different places', () => {
  it('matches Windows paths case-insensitively, as the filesystem does', () => {
    expect(rollUpToProjectFolder('c:\\code\\CADENCE\\src', null, [win])).toBe('c:\\code\\CADENCE')
  })

  // Linux genuinely distinguishes these, and folding them would merge two real
  // projects into one entry.
  it('matches WSL paths case-sensitively, as that filesystem does', () => {
    expect(rollUpToProjectFolder('/home/sheldon/code/app', 'Ubuntu', [wsl])).toBe('/home/sheldon/code/app')
    expect(rollUpToProjectFolder('/home/sheldon/Code/app', 'Ubuntu', [wsl])).toBeNull()
  })

  it('never matches a path against a root from the other origin', () => {
    expect(rollUpToProjectFolder('/home/sheldon/code/app', null, [wsl])).toBeNull()
    expect(rollUpToProjectFolder('C:\\Code\\cadence', 'Ubuntu', [win])).toBeNull()
  })

  it('keeps each origin own separator style in what it returns', () => {
    expect(rollUpToProjectFolder('C:\\Code\\cadence\\src', null, [win])).toBe('C:\\Code\\cadence')
    expect(rollUpToProjectFolder('/home/sheldon/code/app/src', 'Ubuntu', [wsl])).toBe(
      '/home/sheldon/code/app'
    )
  })

  it('distinguishes the same path in two different distros', () => {
    const debian = makeProjectRoot('/home/sheldon/code', 'Debian')
    expect(rollUpToProjectFolder('/home/sheldon/code/app', 'Debian', [wsl])).toBeNull()
    expect(rollUpToProjectFolder('/home/sheldon/code/app', 'Debian', [debian])).toBe(
      '/home/sheldon/code/app'
    )
  })
})

describe('describing a root', () => {
  it('names it after its own folder and keeps a stable id', () => {
    expect(win.label).toBe('Code')
    expect(wsl.label).toBe('code')
    expect(makeProjectRoot('C:\\Code\\', null).id).toBe(makeProjectRoot('c:\\code', null).id)
    expect(makeProjectRoot('/home/a', 'Ubuntu').id).not.toBe(makeProjectRoot('/home/a', null).id)
  })

  it('accepts a chosen label over the folder name', () => {
    expect(makeProjectRoot('C:\\Code', null, 'Work').label).toBe('Work')
    expect(makeProjectRoot('C:\\Code', null, '   ').label).toBe('Code')
  })
})

describe('a folder picked on a WSL share', () => {
  // This is what lets one "Add folder" button serve both origins: the Windows dialog
  // can browse into a distro, and the share path has to become distro + POSIX path.
  it('reads back the distro and the Linux path', () => {
    expect(parseWslSharePath('\\\\wsl.localhost\\Ubuntu\\home\\sheldon\\code')).toEqual({
      distro: 'Ubuntu',
      posixPath: '/home/sheldon/code'
    })
  })

  it('accepts the older share form too', () => {
    expect(parseWslSharePath('\\\\wsl$\\Ubuntu-22.04\\srv')).toEqual({
      distro: 'Ubuntu-22.04',
      posixPath: '/srv'
    })
  })

  it('returns the distro root as /', () => {
    expect(parseWslSharePath('\\\\wsl.localhost\\Ubuntu')).toEqual({ distro: 'Ubuntu', posixPath: '/' })
  })

  it('leaves an ordinary Windows or UNC path alone', () => {
    expect(parseWslSharePath('C:\\Code')).toBeNull()
    expect(parseWslSharePath('\\\\fileserver\\share\\code')).toBeNull()
  })
})
