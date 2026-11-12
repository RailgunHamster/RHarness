/**
 * Windows subprocess compatibility hook for POSIX command names, colon-separated PATHs, and `#!/bin/sh` scripts.
 * No-op on POSIX platforms.
 */
import { ChildProcess } from 'node:child_process'
import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { packagePath } from './paths.ts'

let installed = false

function splitPath(pathStr: string): string[] {
  return pathStr.split(/(?<!^[A-Za-z]|[:;][A-Za-z]):|;/).filter(Boolean)
}

function isShebangScript(filePath: string): boolean {
  try {
    if (!statSync(filePath).isFile()) return false
    const fd = openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(2)
      const bytes = readSync(fd, buf, 0, 2, 0)
      return bytes === 2 && buf[0] === 0x23 && buf[1] === 0x21 // '#!'
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
}

function resolveCandidate(file: string, pathStr: string, cwd?: string): string | undefined {
  if (isAbsolute(file) || file.includes('/') || file.includes('\\')) {
    const target = isAbsolute(file) ? file : join(cwd ?? process.cwd(), file)
    if (existsSync(target)) return target
    return undefined
  }
  for (const dir of splitPath(pathStr)) {
    for (const ext of ['', '.exe', '.cmd']) {
      const candidate = join(dir, file + ext)
      try { if (statSync(candidate).isFile()) return candidate } catch {}
    }
  }
  return undefined
}

function findRealPython(): string {
  const candidates = [
    'C:\\tools\\Miniconda3\\python.exe',
    ...splitPath(process.env.PATH ?? '')
      .filter(dir => !dir.toLowerCase().includes('windowsapps'))
      .map(dir => join(dir, 'python.exe')),
  ]
  for (const c of candidates) {
    try { if (statSync(c).isFile()) return c } catch {}
  }
  return 'python'
}

interface InternalSpawnOptions {
  file: string
  args: string[]
  cwd?: string
  envPairs?: string[]
  windowsHide?: boolean
}
type InternalChildProcess = ChildProcess & {
  spawn(options: InternalSpawnOptions): number
}

export function installPosixWin32(): void {
  if (installed || process.platform !== 'win32') return
  installed = true
  const runnerPath = packagePath('src', 'infra', 'posix-sh-runner.mjs')
  const realPython = findRealPython()
  const proto = ChildProcess.prototype as unknown as InternalChildProcess
  const origSpawn = proto.spawn

  proto.spawn = function (this: InternalChildProcess, options: InternalSpawnOptions) {
    options.windowsHide = true
    const file = options.file
    const args = options.args.slice(1)
    const pathPair = options.envPairs?.find(pair => /^path=/i.test(pair))
    const pathStr = pathPair ? pathPair.slice(pathPair.indexOf('=') + 1) : (process.env.PATH ?? '')

    if (file === 'python3' || file.endsWith('\\python3.exe') || file.endsWith('/python3')) {
      options.file = realPython
      const patchedArgs = [...args]
      if (patchedArgs[0] === '-c' && typeof patchedArgs[1] === 'string' && patchedArgs[1].includes('import fcntl')) {
        patchedArgs[1] = patchedArgs[1]
          .replace('import fcntl,', 'import msvcrt,')
          .replace("open(", "open(")
          .replace(", 'a')", ", 'r+b')")
          .replace('fcntl.flock(lock, fcntl.LOCK_EX)', 'lock.seek(0); msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)')
        const lockFileMatch = /open\((["'][^"']+["'])/.exec(patchedArgs[1])
        if (lockFileMatch) {
          patchedArgs[1] = `import os\n_lf = ${lockFileMatch[1]}\nif not os.path.exists(_lf) or os.path.getsize(_lf) == 0:\n  open(_lf, 'wb').write(b'0')\n` + patchedArgs[1]
        }
      }
      options.args = [realPython, ...patchedArgs]
      options.envPairs = [...(options.envPairs ?? []), `DSH_POSIX_RUNNER=${runnerPath}`, `DSH_NODE_EXE=${process.execPath}`]
      return origSpawn.call(this, options)
    }

    if (file === 'env') {
      if (args.length === 0) {
        options.file = process.execPath
        options.args = [process.execPath, runnerPath, 'env']
        return origSpawn.call(this, options)
      }
      const rest = [...args]
      const extraEnv: string[] = []
      while (rest.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]!)) {
        extraEnv.push(rest.shift()!)
      }
      if (rest.length > 0) {
        options.file = rest[0]!
        options.args = rest
        options.envPairs = [...(options.envPairs ?? []), ...extraEnv]
        return this.spawn(options as never)
      }
    }

    if (file === 'echo') {
      options.file = process.execPath
      options.args = [process.execPath, runnerPath, 'echo', ...args]
      return origSpawn.call(this, options)
    }

    if (file === 'sleep') {
      options.file = process.execPath
      options.args = [process.execPath, runnerPath, 'sleep', args[0] ?? '0']
      return origSpawn.call(this, options)
    }

    if (file === 'sh' && args[0] === '-c') {
      options.file = process.execPath
      options.args = [process.execPath, runnerPath, 'sh-c', args[1] ?? '', ...args.slice(2)]
      return origSpawn.call(this, options)
    }

    const resolved = resolveCandidate(file, pathStr, options.cwd)
    if (resolved && isShebangScript(resolved)) {
      options.file = process.execPath
      options.args = [process.execPath, runnerPath, 'script', resolved, ...args]
      return origSpawn.call(this, options)
    }
    if (resolved && /\.(?:cmd|bat)$/i.test(resolved)) {
      const comspec = process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe'
      options.file = comspec
      options.args = [comspec, '/d', '/c', resolved, ...args]
      return origSpawn.call(this, options)
    }

    return origSpawn.call(this, options)
  }
}

installPosixWin32()
