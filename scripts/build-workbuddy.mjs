import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const dist = path.join(root, 'dist')
const output = path.join(dist, 'workbuddy-rsi')
// Only generated artifacts below this checkout's dist directory may be replaced.
function reset(target) {
  if (!path.resolve(target).startsWith(path.resolve(dist) + path.sep)) throw new Error('Unsafe output path')
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('Refusing symlink output')
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(target, { recursive: true })
}
// Avoid fs.cpSync's native recursive implementation: Node 22.17 on Windows
// can abort on non-ASCII paths. Keep every operation explicit and portable.
function copyTree(source, target) {
  const stat = fs.lstatSync(source)
  if (stat.isSymbolicLink()) throw new Error(`Refusing symlink source: ${source}`)
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true })
    for (const name of fs.readdirSync(source)) copyTree(path.join(source, name), path.join(target, name))
  } else fs.copyFileSync(source, target)
}
reset(output)
copyTree(path.join(root, 'workbuddy/plugin'), output)
for (const name of ['workbuddy-rsi', 'dsh-rsi']) {
  const dest = path.join(output, 'packages', name)
  fs.mkdirSync(dest, { recursive: true })
  copyTree(path.join(root, 'packages', name, 'src'), path.join(dest, 'src'))
  fs.copyFileSync(path.join(root, 'packages', name, 'package.json'), path.join(dest, 'package.json'))
  if (name === 'workbuddy-rsi') copyTree(path.join(root, 'packages', name, 'bin'), path.join(dest, 'bin'))
  if (name === 'dsh-rsi') copyTree(path.join(root, 'packages', name, 'docs'), path.join(dest, 'docs'))
}
for (const name of ['LICENSE', 'NOTICE', 'README.md']) fs.copyFileSync(path.join(root, name), path.join(output, name))
copyTree(path.join(root, 'docs/workbuddy'), path.join(output, 'docs/workbuddy'))
copyTree(path.join(root, 'assets/workbuddy'), path.join(output, 'assets/workbuddy'))
const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd']
const hooks = Object.fromEntries(events.map(event => [event, [{
  ...(event.startsWith('PreTool') || event.startsWith('PostTool') ? { matcher: '*' } : {}),
  hooks: [{ type: 'command', command: 'node "${CODEBUDDY_PLUGIN_ROOT}/packages/workbuddy-rsi/bin/hook.mjs"', timeout: 20 }],
}]]))
fs.mkdirSync(path.join(output, 'hooks'), { recursive: true })
fs.writeFileSync(path.join(output, 'hooks/hooks.json'), JSON.stringify({ description: 'WorkBuddy RSI native lifecycle hooks', hooks }, null, 2) + '\n')
const marketplace = path.join(dist, 'workbuddy-rsi-marketplace')
reset(marketplace)
fs.mkdirSync(path.join(marketplace, '.codebuddy-plugin'), { recursive: true })
copyTree(output, path.join(marketplace, 'plugins/workbuddy-rsi'))
fs.writeFileSync(path.join(marketplace, '.codebuddy-plugin/marketplace.json'), JSON.stringify({
  name: 'dshrsi-workbuddy', owner: { name: 'yd (xingchenyd)' },
  plugins: [{ name: 'workbuddy-rsi', source: './plugins/workbuddy-rsi', description: 'WorkBuddy RSI native plugin', version: JSON.parse(fs.readFileSync(path.join(root, 'packages/workbuddy-rsi/package.json'), 'utf8')).version }],
}, null, 2) + '\n')
console.log(JSON.stringify({ plugin: output, marketplace }, null, 2))
