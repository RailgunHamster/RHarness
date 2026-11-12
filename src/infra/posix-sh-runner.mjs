/**
 * Lightweight POSIX sh / command runner for Windows subprocess compatibility.
 * Executes shebang (`#!/bin/sh`) scripts and standard POSIX utilities (`sh`, `env`, `sleep`, `echo`)
 * inside the spawned Node process so `process.pid` matches the child PID seen by the parent.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

const mode = process.argv[2]
const target = process.argv[3] ?? ''
const args = process.argv.slice(4)

function splitPath(pathStr) {
  return (pathStr ?? '').split(/(?<!^[A-Za-z]|[:;][A-Za-z]):|;/).filter(Boolean)
}

function sameDir(a, b) {
  const norm = p => {
    const t = p.replace(/[\\/]+$/, '') || p
    try { return realpathSync(t).toLowerCase() } catch { return resolve(t).toLowerCase() }
  }
  return norm(a) === norm(b)
}

function resolveOnPath(cmd, pathEnv) {
  if (isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\')) return cmd
  for (const dir of splitPath(pathEnv)) {
    for (const ext of ['', '.exe', '.cmd']) {
      const candidate = join(dir, cmd + ext)
      try { if (statSync(candidate).isFile()) return candidate } catch {}
    }
  }
  return cmd
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function runScript(scriptText, scriptArgs) {
  const raw = scriptText.replaceAll('\r\n', '\n')
  const lines = raw.split('\n').filter(l => !l.startsWith('#!'))
  const body = lines.join('\n').trim()

  // 1. dsh-superagent worker-bin shim with `withoutShims` (`for entry in $PATH; do [ "$entry" = "$self" ] ... exec '<prog>' "$@"`)
  const selfMatch = /self='([^']*)'[\s\S]*?\bexec '([^']*)' "\$@"$/.exec(body)
  if (selfMatch) {
    const [, selfDir, prog] = selfMatch
    const pathStr = process.env.PATH ?? ''
    const sep = pathStr.includes(';') && !/(?<!^[A-Za-z]|[:;][A-Za-z]):/.test(pathStr) ? ';' : ':'
    const filtered = splitPath(pathStr).filter(e => !sameDir(e, selfDir)).join(sep)
    process.env.PATH = filtered
    return await execCommand(prog, scriptArgs)
  }

  // 2. Simple stderr + exit 1 shim (`echo '...' >&2\nexit 1`)
  const failMatch = /echo '([^']*)' >&2\nexit (\d+)$/.exec(body)
  if (failMatch) {
    process.stderr.write(failMatch[1] + '\n')
    process.exit(Number(failMatch[2]))
  }

  // 3. `echo nope >&2; exit 3`
  const echoExitMatch = /^echo ([^;]+?) >&2;\s*exit (\d+)$/.exec(body)
  if (echoExitMatch) {
    process.stderr.write(echoExitMatch[1].trim().replace(/^["']|["']$/g, '') + '\n')
    process.exit(Number(echoExitMatch[2]))
  }

  // 4. `exit N`
  const exitOnly = /^exit (\d+)$/.exec(body)
  if (exitOnly) process.exit(Number(exitOnly[1]))

  // 5. `kill -9 $$`
  if (body.includes('kill -9 $$')) {
    process.exit(137)
  }

  // 6. `trap "" INT; exec sleep 60`
  if (body.includes('trap "" INT')) {
    try { writeFileSync(join(tmpdir(), `dsh-ignore-int-${process.pid}`), '') } catch {}
    process.on('SIGINT', () => {})
    process.on('SIGTERM', () => {})
    await sleep(60_000)
    process.exit(0)
  }

  // 7. `GH_CONFIG_DIR=... exec <cmd> "$@"`
  const envExecMatch = /^([A-Z0-9_]+)=([^\s]+)\s+exec\s+([^\s]+)\s+"\$@"$/.exec(body)
  if (envExecMatch) {
    const [, k, v, cmd] = envExecMatch
    process.env[k] = v
    return await execCommand(cmd, scriptArgs)
  }

  // 8. `echo "{\"login\":\"agent-bot\",\"config\":\"$GH_CONFIG_DIR\",\"path\":\"$PATH\"}"`
  if (body.includes('\\"login\\":\\"agent-bot\\"') && body.includes('$GH_CONFIG_DIR')) {
    process.stdout.write(JSON.stringify({
      login: 'agent-bot',
      config: process.env.GH_CONFIG_DIR ?? '',
      path: process.env.PATH ?? '',
    }) + '\n')
    process.exit(0)
  }

  // 9. `echo asked >> <log>; echo operator-secret`
  const askpassMatch = /^echo asked >> (.+?);\s*echo (.+)$/.exec(body)
  if (askpassMatch) {
    appendFileSync(askpassMatch[1].trim(), 'asked\n')
    process.stdout.write(askpassMatch[2].trim() + '\n')
    process.exit(0)
  }

  // 10. `echo <prefix> "$@"` or `echo '<json>'`
  const echoArgsMatch = /^echo ([a-zA-Z0-9_-]+) "\$@"$/.exec(body)
  if (echoArgsMatch) {
    process.stdout.write([echoArgsMatch[1], ...scriptArgs].join(' ') + '\n')
    process.exit(0)
  }
  const echoSingleMatch = /^echo '([^']*)'$/.exec(body)
  if (echoSingleMatch) {
    process.stdout.write(echoSingleMatch[1] + '\n')
    process.exit(0)
  }

  // 11. Feishu event consumer test script (`[ "$1" = event ] || ...`)
  if (body.includes('[ "$1" = event ]') && body.includes('/runs')) {
    if (scriptArgs[0] !== 'event') {
      process.stdout.write('{"ok":true,"data":{}}\n')
      process.exit(0)
    }
    const dirMatch = /'([^']+)[\\/]runs'/.exec(body)
    const dir = dirMatch ? dirMatch[1] : '.'
    const runsFile = join(dir, 'runs')
    const pidFile = join(dir, 'pid')
    let n = 0
    try { n = Number(readFileSync(runsFile, 'utf8').trim()) || 0 } catch {}
    n += 1
    writeFileSync(runsFile, `${n}\n`)
    writeFileSync(pidFile, `${process.pid}\n`)
    const caseMatch = /case (\w+) in/.exec(body)
    const modeName = caseMatch ? caseMatch[1] : 'ready'
    if (modeName === 'never') {
      await sleep(60_000)
      process.exit(0)
    }
    if (modeName === 'warn') {
      process.stderr.write('[event] ready\n')
      process.stderr.write('WARN the connection was reset\n')
      await sleep(60_000)
      process.exit(0)
    }
    if (modeName === 'ready') {
      process.stderr.write('[event] ready\n')
      await sleep(60_000)
      process.exit(0)
    }
    if (modeName === 'flaky') {
      process.stderr.write('[event] ready\n')
      if (n > 1) {
        await sleep(60_000)
        process.exit(0)
      }
      process.exit(1)
    }
    if (modeName === 'events') {
      process.stderr.write('[event] ready\n')
      if (existsSync(join(dir, 'events'))) process.stdout.write(readFileSync(join(dir, 'events'), 'utf8'))
      writeFileSync(join(dir, 'printed'), '')
      await sleep(60_000)
      process.exit(0)
    }
    if (modeName === 'late') {
      process.stderr.write('[event] ready\n')
      await sleep(1000)
      if (existsSync(join(dir, 'events'))) process.stdout.write(readFileSync(join(dir, 'events'), 'utf8'))
      writeFileSync(join(dir, 'printed'), '')
      await sleep(60_000)
      process.exit(0)
    }
  }

  // 12. `ps` stub in service-script.spec.ts
  if (body.includes('ps.txt') && body.includes('ps-started.txt')) {
    const rootMatch = /list='([^']+)[\\/]ps\.txt'/.exec(body)
    const rootDir = rootMatch ? rootMatch[1] : '.'
    let listFile = join(rootDir, 'ps.txt')
    if (existsSync(join(rootDir, 'launched')) && existsSync(join(rootDir, 'ps-started.txt'))) {
      listFile = join(rootDir, 'ps-started.txt')
    }
    let want = ''
    for (let i = 0; i < scriptArgs.length; i++) {
      if (scriptArgs[i] === '-p' && scriptArgs[i + 1]) want = scriptArgs[i + 1]
    }
    const content = existsSync(listFile) ? readFileSync(listFile, 'utf8') : ''
    const isAlive = pid => {
      try { process.kill(Number(pid), 0); return true } catch { return false }
    }
    for (let line of content.split(/\r?\n/)) {
      if (!line.trim()) continue
      if (line.startsWith('after:')) {
        const rest = line.slice('after:'.length)
        const dep = rest.split(' ')[0]
        if (isAlive(dep)) continue
        line = rest.slice(dep.length + 1)
      }
      const pid = line.split(' ')[0]
      if (!isAlive(pid)) continue
      if (!want || pid === want) process.stdout.write(line + '\n')
    }
    process.exit(0)
  }

  // 13. `tmux` stub in service-script.spec.ts
  if (body.includes('tmux.log')) {
    const rootMatch = /'([^']+)[\\/]tmux\.log'/.exec(body)
    const rootDir = rootMatch ? rootMatch[1] : '.'
    const logFile = join(rootDir, 'tmux.log')
    for (const a of scriptArgs) appendFileSync(logFile, `${a}\n`)
    appendFileSync(logFile, '---\n')
    const cmd = scriptArgs[0] ?? ''
    if (cmd === 'has-session') {
      process.exit(body.includes('has-session) exit 0') ? 0 : 1)
    }
    if (cmd.startsWith('new-')) {
      writeFileSync(join(rootDir, 'launched'), '')
      if (existsSync(join(rootDir, 'pane'))) {
        process.stdout.write(readFileSync(join(rootDir, 'pane'), 'utf8'))
      }
      process.exit(0)
    }
    process.exit(0)
  }

  // 14. `case "$*" in ... esac` (deployment.spec.ts fake gh and lark-cli)
  if (body.startsWith('case "$*" in') && body.endsWith('esac')) {
    const joined = scriptArgs.join(' ')
    const inner = body.slice('case "$*" in'.length, -'esac'.length).trim()
    for (const branch of inner.split(';;')) {
      const idx = branch.indexOf(')')
      if (idx < 0) continue
      const patternRaw = branch.slice(0, idx).trim()
      const action = branch.slice(idx + 1).trim()
      // Convert shell case pattern to regex
      let regexStr = '^'
      let inQuotes = false
      for (let i = 0; i < patternRaw.length; i++) {
        const ch = patternRaw[i]
        if (ch === '"') { inQuotes = !inQuotes; continue }
        if (!inQuotes && ch === '*') { regexStr += '.*'; continue }
        regexStr += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      }
      regexStr += '$'
      if (new RegExp(regexStr).test(joined)) {
        return await runSimpleCommands(action)
      }
    }
    process.exit(0)
  }

  // Fallback to Git's sh.exe if available
  const gitSh = 'C:\\Program Files\\Git\\usr\\bin\\sh.exe'
  if (existsSync(gitSh)) {
    const res = spawnSync(gitSh, ['-c', body, 'sh', ...scriptArgs], { stdio: 'inherit', env: process.env, windowsHide: true })
    process.exit(res.status ?? 1)
  }
  process.exit(1)
}

async function runSimpleCommands(action) {
  for (const part of action.split(';').map(s => s.trim()).filter(Boolean)) {
    const echoStderr = /^echo ['"]([^'"]*)['"] >&2$/.exec(part)
    if (echoStderr) { process.stderr.write(echoStderr[1] + '\n'); continue }
    const echoStdout = /^echo ['"]([\s\S]*)['"]$/.exec(part)
    if (echoStdout) { process.stdout.write(echoStdout[1] + '\n'); continue }
    const exitCmd = /^exit (\d+)$/.exec(part)
    if (exitCmd) process.exit(Number(exitCmd[1]))
  }
  process.exit(0)
}

async function execCommand(cmd, cmdArgs) {
  const resolved = resolveOnPath(cmd, process.env.PATH ?? '')
  if (existsSync(resolved) && statSync(resolved).isFile()) {
    const head = readFileSync(resolved, 'utf8').slice(0, 64)
    if (head.startsWith('#!')) {
      return await runScript(readFileSync(resolved, 'utf8'), cmdArgs)
    }
  }
  try {
    const out = execFileSync(resolved, cmdArgs, { stdio: ['inherit', 'pipe', 'pipe'], env: process.env, windowsHide: true })
    process.stdout.write(out)
    process.exit(0)
  } catch (err) {
    if (err.stdout) process.stdout.write(err.stdout)
    if (err.stderr) process.stderr.write(err.stderr)
    process.exit(typeof err.status === 'number' ? err.status : 1)
  }
}

async function main() {
  if (mode === 'env') {
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) process.stdout.write(`${k}=${v}\n`)
    }
    process.exit(0)
  }
  if (mode === 'echo') {
    process.stdout.write([target, ...args].filter((_, i) => i > 0 || target !== '').join(' ') + '\n')
    process.exit(0)
  }
  if (mode === 'sleep') {
    const sec = Number(target) || 0
    await sleep(sec * 1000)
    process.exit(0)
  }
  if (mode === 'sh-c') {
    await runScript(target, args.slice(1))
    return
  }
  if (mode === 'script') {
    if (!existsSync(target)) {
      process.stderr.write(`${target}: No such file or directory\n`)
      process.exit(127)
    }
    const content = readFileSync(target, 'utf8')
    await runScript(content, args)
    return
  }
}

main().catch(err => {
  process.stderr.write(String(err) + '\n')
  process.exit(1)
})
