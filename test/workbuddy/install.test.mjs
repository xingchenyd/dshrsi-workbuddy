import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseArgs, cliCandidates, discoverCli, createEnvironment, createPlan,
  readMarketplace, install, runCommand, verifyInstalledPlugin, PLUGIN_ID,
} from '../../scripts/install-workbuddy.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rsi-install-中文 '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marketplace = path.join(directory, 'marketplace');
  const plugin = path.join(marketplace, 'plugins', 'workbuddy-rsi');
  await mkdir(path.join(marketplace, '.codebuddy-plugin'), { recursive: true });
  await mkdir(path.join(plugin, '.workbuddy-plugin'), { recursive: true });
  await writeFile(path.join(marketplace, '.codebuddy-plugin', 'marketplace.json'), JSON.stringify({
    name: 'dshrsi-workbuddy', plugins: [{ name: 'workbuddy-rsi', source: './plugins/workbuddy-rsi' }],
  }));
  await writeFile(path.join(plugin, '.workbuddy-plugin', 'plugin.json'), '{"name":"workbuddy-rsi","version":"0.1.0"}');
  const cli = path.join(directory, 'codebuddy');
  await writeFile(cli, '// fixture, never executed');
  return { directory, marketplace, plugin, cli };
}

test('installer rejects unknown or incomplete arguments before invoking the desktop', () => {
  assert.deepEqual(parseArgs(['--dry-run', '--config-dir', 'folder', '--timeout-ms', '2000']), { dryRun: true, configDir: 'folder', timeoutMs: 2000 });
  assert.throws(() => parseArgs(['--cli']), /requires a value/);
  assert.throws(() => parseArgs(['--force']), /Unknown option/);
  for (const value of ['abc', '-1', '0', '999', '600001']) assert.throws(() => parseArgs(['--timeout-ms', value]), /integer between/);
});

test('desktop discovery checks WorkBuddyAI and WorkBuddy without assuming CodeBuddy CLI', () => {
  const candidates = cliCandidates({ platform: 'win32', env: { LOCALAPPDATA: 'custom-local' }, userHome: 'ignored' });
  assert.equal(candidates.length, 2);
  assert.match(candidates[0], /WorkBuddyAI/);
  assert.match(candidates[1], /WorkBuddy/);
  assert.equal(discoverCli({ platform: 'win32', env: { LOCALAPPDATA: 'custom-local' } }, value => value === candidates[1]), candidates[1]);
  assert.throws(() => discoverCli({}, () => false), /--cli/);
  assert.ok(cliCandidates({ platform: 'darwin', userHome: '/users/test' }).some(value => value.includes('Contents')));
  assert.ok(cliCandidates({ platform: 'linux', userHome: '/users/test' }).every(value => value.endsWith(path.join('bin', 'codebuddy'))));
});

test('isolated environment overrides both configuration directories without mutating the parent environment', () => {
  const before = { PATH: 'example', CODEBUDDY_CONFIG_DIR: 'real-user', WORKBUDDY_CONFIG_DIR: 'real-workbuddy' };
  const environment = createEnvironment('isolated', before);
  assert.equal(environment.CODEBUDDY_CONFIG_DIR, 'isolated');
  assert.equal(environment.WORKBUDDY_CONFIG_DIR, 'isolated');
  assert.equal(environment.CODEBUDDY_HOST, 'workbuddy-desktop');
  assert.equal(environment.CODEBUDDY_FORCE_LITE_WB_BUNDLE, '1');
  assert.equal(environment.PATH, 'example');
  assert.equal(before.CODEBUDDY_CONFIG_DIR, 'real-user');
});

test('marketplace rejects sources that escape its directory', async t => {
  const f = await fixture(t);
  assert.equal(readMarketplace(f.marketplace).pluginDir, f.plugin);
  await writeFile(path.join(f.marketplace, '.codebuddy-plugin', 'marketplace.json'), JSON.stringify({
    name: 'dshrsi-workbuddy', plugins: [{ name: 'workbuddy-rsi', source: './../outside' }],
  }));
  assert.throws(() => readMarketplace(f.marketplace), /stay inside/);
});

test('dry run starts no processes and preserves unrelated configuration exactly', async t => {
  const f = await fixture(t);
  const configDir = path.join(f.directory, 'config');
  await mkdir(configDir);
  const settings = path.join(configDir, 'settings.json');
  const contents = '{"enabledPlugins":{"unrelated@existing":true},"theme":"dark"}\n';
  await writeFile(settings, contents);
  const result = await install({ ...f, configDir, dryRun: true }, {
    log() {}, runCommand() { throw new Error('must not run'); },
  });
  assert.equal(result.results.length, 0);
  assert.equal(await readFile(settings, 'utf8'), contents);
  assert.deepEqual(result.plan.commands[3].args.slice(-5), ['plugin', 'install', PLUGIN_ID, '--scope', 'user']);
});

test('validate-only uses native manifest validation and never registers a marketplace', async t => {
  const f = await fixture(t);
  const seen = [];
  await install({ ...f, validateOnly: true }, { log() {}, async runCommand(command, args, options) {
    seen.push({ command, args, options }); return { exitCode: 0 };
  } });
  assert.equal(seen.length, 2);
  assert.ok(seen.every(step => step.args.includes('validate')));
  assert.ok(seen.every(step => step.options.env.CODEBUDDY_HOST === 'workbuddy-desktop'));
});

test('installer stops on validation failure before registering or installing anything', async t => {
  const f = await fixture(t);
  const seen = [];
  await assert.rejects(install(f, { log() {}, async runCommand(command, args) {
    seen.push(args); throw new Error('manifest invalid');
  } }), /manifest invalid/);
  assert.equal(seen.length, 1);
});

test('repeat installs delegate idempotency to native marketplace/install commands without direct settings edits', async t => {
  const f = await fixture(t);
  const calls = [];
  const dependencies = { log() {}, async runCommand(command, args) {
    calls.push(args);
    return { exitCode: 0, stdout: JSON.stringify([{ id: PLUGIN_ID, scope: 'user', enabled: true, version: '0.1.0' }]) };
  } };
  await install(f, dependencies);
  await install(f, dependencies);
  assert.equal(calls.length, 10);
  assert.deepEqual(calls.slice(0, 5), calls.slice(5));
  assert.ok(calls.every(args => !args.includes('uninstall') && !args.includes('remove')));
});

test('installation succeeds only when native registry reports the expected enabled version', () => {
  const valid = { id: PLUGIN_ID, scope: 'user', enabled: true, version: '0.1.0' };
  assert.equal(verifyInstalledPlugin(JSON.stringify([valid]), '0.1.0').id, PLUGIN_ID);
  assert.throws(() => verifyInstalledPlugin('[]', '0.1.0'), /not reported enabled/);
  assert.throws(() => verifyInstalledPlugin(JSON.stringify([{ ...valid, enabled: false }]), '0.1.0'), /not reported enabled/);
  assert.throws(() => verifyInstalledPlugin(JSON.stringify([valid]), '0.2.0'), /differs from built version/);
  assert.throws(() => verifyInstalledPlugin('not JSON', '0.1.0'), /valid JSON/);
});

test('command execution passes hostile-looking paths literally without shell interpretation', async () => {
  const argument = '中文 folder; $(no_execution) & "quote"';
  const result = await runCommand(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', argument], {
    env: process.env, timeoutMs: 5000, log() {},
  });
  assert.deepEqual(JSON.parse(result.stdout), [argument]);
  await assert.rejects(runCommand(process.execPath, ['-e', 'process.exit(4)'], { env: process.env, timeoutMs: 5000, log() {} }), /exit 4/);
});
