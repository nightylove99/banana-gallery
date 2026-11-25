import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function findPython() {
  const candidates = process.platform === 'win32'
    ? [['py', ['-3']], ['python', []], ['python3', []]]
    : [['python3', []], ['python', []]]

  for (const [executable, args] of candidates) {
    const result = spawnSync(executable, [...args, '--version'], { encoding: 'utf8' })
    if (result.status !== 0) continue
    const version = result.stdout.trim()
    const match = /^Python 3\.(\d+)\./.exec(version)
    if (match && Number(match[1]) >= 10) {
      return { executable, args, command: [executable, ...args].join(' '), version }
    }
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const python = findPython()
  if (!python) {
    console.error('Python 3.10+ is required. Install Python and reopen the terminal.')
    process.exitCode = 1
  } else {
    const result = spawnSync(python.executable, [...python.args, ...process.argv.slice(2)], { stdio: 'inherit' })
    if (result.error) console.error(result.error.message)
    process.exitCode = result.status ?? 1
  }
}
