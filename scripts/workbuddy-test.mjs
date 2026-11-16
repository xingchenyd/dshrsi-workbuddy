import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const group = process.argv[2] ?? 'all'
const dirs = group === 'unit' ? ['test/unit'] : group === 'adapter' ? ['test/workbuddy'] : ['test/unit', 'test/workbuddy']
const files = dirs.flatMap(dir => readdirSync(path.join(root, dir)).filter(n => n.endsWith('.test.mjs')).sort().map(n => `${dir}/${n}`))
const result = spawnSync(process.execPath, ['--test', '--test-timeout=90000', ...files], { cwd: root, stdio: 'inherit', windowsHide: true })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
