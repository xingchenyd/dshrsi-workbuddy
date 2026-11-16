import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const repository = fileURLToPath(new URL('../../', import.meta.url))
function copyTree(source, target) {
  const stat = fs.lstatSync(source)
  assert.equal(stat.isSymbolicLink(), false, `Unexpected source link: ${source}`)
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true })
    for (const name of fs.readdirSync(source)) copyTree(path.join(source, name), path.join(target, name))
  } else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target) }
}
function files(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(path.join(root, entry.name)) : [path.join(root, entry.name)])
}
function run(args, options = {}) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 20000, windowsHide: true, ...options })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, `Node command failed: ${result.stderr}\n${result.stdout}`)
  return result.stdout.trim()
}

test('clean build is self-contained after source removal, including the bundled skill CLI', async t => {
  // Build in a separate checkout-shaped directory: npm test never overwrites a
  // user's registered local marketplace or another test's native installation.
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-rsi bundle 空格-'))
  const source = path.join(temporary, 'source')
  const home = path.join(temporary, 'isolated-state')
  const detached = path.join(temporary, 'detached-plugin')
  const marketplace = path.join(temporary, 'detached-marketplace')
  let cli
  t.after(() => {
    if (cli && fs.existsSync(cli)) spawnSync(process.execPath, [cli, 'stop', '--home', home], { encoding: 'utf8', timeout: 15000, windowsHide: true })
    // This absolute path was returned by mkdtemp; it cannot escape its dedicated fixture.
    fs.rmSync(temporary, { recursive: true, force: true })
  })
  for (const item of ['scripts/build-workbuddy.mjs', 'workbuddy/plugin', 'packages/workbuddy-rsi', 'packages/dsh-rsi/src', 'packages/dsh-rsi/docs', 'packages/dsh-rsi/package.json', 'LICENSE', 'NOTICE', 'README.md', 'AUTHORS.md', 'README.upstream.md', 'docs/workbuddy']) {
    copyTree(path.join(repository, item), path.join(source, item))
  }
  // Git does not preserve empty directories. Exercise a fresh checkout rather
  // than accidentally relying on the developer's untracked hooks directory.
  const optionalHooks = path.join(source, 'workbuddy/plugin/hooks')
  if (fs.existsSync(optionalHooks) && fs.readdirSync(optionalHooks).length === 0) fs.rmdirSync(optionalHooks)
  const built = JSON.parse(run([path.join(source, 'scripts/build-workbuddy.mjs')], { cwd: temporary }))
  assert.equal(built.plugin, path.join(source, 'dist/workbuddy-rsi'))
  fs.renameSync(built.plugin, detached)
  fs.renameSync(built.marketplace, marketplace)
  fs.rmSync(source, { recursive: true, force: true })

  const pluginManifest = JSON.parse(fs.readFileSync(path.join(detached, '.workbuddy-plugin/plugin.json'), 'utf8'))
  assert.equal(pluginManifest.name, 'workbuddy-rsi')
  assert.equal(pluginManifest.version, JSON.parse(fs.readFileSync(path.join(detached, 'packages/workbuddy-rsi/package.json'), 'utf8')).version)
  const marketManifest = JSON.parse(fs.readFileSync(path.join(marketplace, '.codebuddy-plugin/marketplace.json'), 'utf8'))
  const marketPlugin = path.resolve(marketplace, marketManifest.plugins[0].source)
  for (const item of files(detached)) {
    const relative = path.relative(detached, item)
    assert.deepEqual(fs.readFileSync(path.join(marketPlugin, relative)), fs.readFileSync(item), `Marketplace omitted or changed ${relative}`)
  }
  for (const item of ['AUTHORS.md', 'README.upstream.md', 'docs/workbuddy/INSTALL.md', 'docs/workbuddy/DESIGN.md', 'docs/workbuddy/CONTRIBUTING.md', 'packages/dsh-rsi/docs/DETAIL.md']) {
    assert.ok(fs.statSync(path.join(detached, item)).isFile(), `Missing linked documentation: ${item}`)
  }
  for (const markdown of files(path.join(detached, 'skills')).filter(item => item.endsWith('.md'))) {
    for (const match of fs.readFileSync(markdown, 'utf8').matchAll(/\[[^\]]*\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
      if (!/^[a-z][a-z0-9+.-]*:/i.test(match[1])) assert.ok(fs.existsSync(path.resolve(path.dirname(markdown), match[1])), `Skill reference does not resolve: ${match[1]}`)
    }
  }

  // Actual ES-module loading verifies the complete runtime import closure, not
  // just the filenames that the build script happened to copy.
  const modules = files(path.join(detached, 'packages')).filter(item => /[/\\]src[/\\].*\.m?js$/.test(item)).map(item => pathToFileURL(item).href)
  run(['--input-type=module', '-e', `for (const item of ${JSON.stringify(modules)}) await import(item)`], { cwd: temporary })
  const hooks = JSON.parse(fs.readFileSync(path.join(detached, 'hooks/hooks.json'), 'utf8')).hooks
  for (const [event, entries] of Object.entries(hooks)) {
    assert.ok(entries.length > 0, `Missing hook entries: ${event}`)
    for (const entry of entries) for (const hook of entry.hooks) {
      const match = /^node "\$\{CODEBUDDY_PLUGIN_ROOT\}\/([^"]+)"$/.exec(hook.command)
      assert.ok(match, `Unsupported packaged hook command: ${hook.command}`)
      assert.ok(fs.statSync(path.join(detached, match[1])).isFile(), `Hook entrypoint missing: ${event}`)
    }
  }

  cli = path.join(detached, 'packages/workbuddy-rsi/bin/rsi.mjs')
  const skillCli = path.join(detached, 'skills/workbuddy-rsi/scripts/rsi.mjs')
  assert.match(run([cli, '--help'], { cwd: temporary }), /DSHRSI for WorkBuddy/)
  assert.match(run([skillCli, '--help'], { cwd: temporary }), /DSHRSI for WorkBuddy/)
  const status = JSON.parse(run([skillCli, 'status', '--home', home], { cwd: temporary }))
  assert.equal(status.enabled, true)
  assert.equal(status.generator, 'synth')
  assert.deepEqual(status.records, [])
  const hookReply = JSON.parse(run([path.join(detached, 'packages/workbuddy-rsi/bin/hook.mjs')], {
    cwd: temporary, env: { ...process.env, WB_RSI_HOME: home },
    input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'bundle-test', cwd: temporary }),
  }))
  assert.deepEqual(hookReply, {})
  const observed = JSON.parse(run([cli, 'status', '--home', home], { cwd: temporary }))
  assert.deepEqual(observed.sessions, [{ sessionId: 'bundle-test', cwd: temporary }])
  const stopped = JSON.parse(run([skillCli, 'stop', '--home', home], { cwd: temporary }))
  assert.equal(stopped.stopped, true)
})
