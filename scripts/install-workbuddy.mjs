#!/usr/bin/env node
/** Install through WorkBuddy's own plugin manager; never edit its registry files. */
import { existsSync, readFileSync, readdirSync, statSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

export const MARKETPLACE_NAME = 'dshrsi-workbuddy';
export const PLUGIN_ID = `workbuddy-rsi@${MARKETPLACE_NAME}`;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `Install DSHRSI for WorkBuddy using the desktop application's plugin manager.

Usage: node scripts/install-workbuddy.mjs [options]
  --dry-run                  Print the plan without starting WorkBuddy or writing files
  --validate-only            Validate both manifests; do not install or enable the plugin
  --config-dir <directory>   WorkBuddy configuration directory (default: ~/.workbuddy)
  --marketplace <directory>  Built marketplace (default: dist/workbuddy-rsi-marketplace)
  --cli <file>               Desktop bundled cli/bin/codebuddy, or a native executable
  --node <file>              Node.js executable used for the bundled JavaScript CLI
  --timeout-ms <number>      Per-command timeout (default: 120000)
  --help                    Show this help

Build first with npm run build:workbuddy. Keep the built marketplace directory in
place after installation. The native CLI handles registration and preserves other
plugins/settings. This does not start a model conversation or configure models.
Plugin payloads are versioned: bump the plugin and marketplace entry versions when
changing packaged files. The installer checks installed file hashes after install.
`;

export function parseArgs(args) {
  const result = {};
  const values = new Map([
    ['--config-dir', 'configDir'], ['--marketplace', 'marketplace'],
    ['--cli', 'cli'], ['--node', 'node'], ['--timeout-ms', 'timeoutMs'],
  ]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--validate-only') result.validateOnly = true;
    else if (values.has(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      result[values.get(arg)] = value;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (result.timeoutMs !== undefined) {
    result.timeoutMs = Number(result.timeoutMs);
    if (!Number.isSafeInteger(result.timeoutMs) || result.timeoutMs < 1000 || result.timeoutMs > 600000) {
      throw new Error('--timeout-ms must be an integer between 1000 and 600000');
    }
  }
  return result;
}

function isFile(location) {
  try { return statSync(location).isFile(); } catch { return false; }
}

export function cliCandidates({ platform = process.platform, env = process.env, userHome = homedir() } = {}) {
  const suffix = ['resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy'];
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(userHome, 'AppData', 'Local');
    return ['WorkBuddyAI', 'WorkBuddy'].map(name => path.join(local, 'Programs', name, ...suffix));
  }
  if (platform === 'darwin') {
    return ['/Applications', path.join(userHome, 'Applications')].flatMap(base =>
      ['WorkBuddy.app', 'WorkBuddyAI.app'].map(name => path.join(base, name, 'Contents', 'Resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy')));
  }
  return ['/opt/WorkBuddy', '/opt/workbuddy', '/opt/WorkBuddyAI', path.join(userHome, '.local', 'share', 'workbuddy')]
    .map(base => path.join(base, ...suffix));
}

export function discoverCli(options = {}, fileExists = isFile) {
  if (options.cli) {
    const cli = path.resolve(options.cli);
    if (!fileExists(cli)) throw new Error(`WorkBuddy CLI not found: ${cli}`);
    return cli;
  }
  const cli = cliCandidates(options).find(fileExists);
  if (!cli) throw new Error('WorkBuddy desktop bundled CLI was not found. Install WorkBuddy, or pass --cli with the full path to its cli/bin/codebuddy entry. See README.md for installation instructions.');
  return cli;
}

export function createEnvironment(configDir, env = process.env) {
  return {
    ...env,
    CODEBUDDY_FORCE_LITE_WB_BUNDLE: '1',
    CODEBUDDY_HOST: 'workbuddy-desktop',
    CODEBUDDY_CONFIG_DIR: configDir,
    WORKBUDDY_CONFIG_DIR: configDir,
    CODEBUDDY_SESSION_HISTORY_CLEANUP: '0',
    NO_COLOR: '1',
  };
}

export function readMarketplace(marketplace) {
  const manifestPath = path.join(marketplace, '.codebuddy-plugin', 'marketplace.json');
  if (!existsSync(manifestPath)) throw new Error(`Built marketplace is missing: ${manifestPath}. Run npm run build:workbuddy first.`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.name !== MARKETPLACE_NAME) throw new Error(`Unexpected marketplace name: ${manifest.name}`);
  const entry = manifest.plugins?.find(plugin => plugin.name === 'workbuddy-rsi');
  if (!entry || typeof entry.source !== 'string' || !entry.source.startsWith('./')) {
    throw new Error('Marketplace must contain workbuddy-rsi with a local ./ source');
  }
  const pluginDir = path.resolve(marketplace, entry.source);
  const relative = path.relative(marketplace, pluginDir);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Plugin source must stay inside the built marketplace directory');
  }
  const pluginManifestPath = ['.workbuddy-plugin', '.codebuddy-plugin']
    .map(folder => path.join(pluginDir, folder, 'plugin.json')).find(isFile);
  if (!pluginManifestPath) {
    throw new Error(`Built plugin manifest is missing under ${pluginDir}`);
  }
  const pluginManifest = JSON.parse(readFileSync(pluginManifestPath, 'utf8'));
  if (pluginManifest.name !== 'workbuddy-rsi' || typeof pluginManifest.version !== 'string') {
    throw new Error('Built plugin must declare name workbuddy-rsi and a version');
  }
  return { manifestPath, pluginDir, pluginVersion: pluginManifest.version };
}

export function createPlan(options = {}, dependencies = {}) {
  const marketplace = path.resolve(options.marketplace || path.join(repositoryRoot, 'dist', 'workbuddy-rsi-marketplace'));
  const configDir = path.resolve(options.configDir || path.join(homedir(), '.workbuddy'));
  const cli = (dependencies.discoverCli || discoverCli)(options);
  const { pluginDir, pluginVersion } = (dependencies.readMarketplace || readMarketplace)(marketplace);
  // The desktop's extensionless bin/codebuddy is JavaScript. Explicit native
  // executable overrides are also supported without invoking a shell.
  const native = /\.(?:exe|com)$/i.test(cli);
  const command = native ? cli : (options.node || process.execPath);
  const prefix = native ? [] : [cli];
  const commands = [
    ['plugin', 'validate', marketplace],
    ['plugin', 'validate', pluginDir],
  ];
  if (!options.validateOnly) commands.push(
    ['plugin', 'marketplace', 'add', marketplace, '--name', MARKETPLACE_NAME],
    ['plugin', 'marketplace', 'update', MARKETPLACE_NAME],
    ['plugin', 'install', PLUGIN_ID, '--scope', 'user'],
    ['plugin', 'update', PLUGIN_ID, '--scope', 'user'],
    ['plugin', 'list', '--json'],
  );
  return {
    cli, command, prefix, marketplace, pluginDir, pluginVersion, configDir,
    environment: createEnvironment(configDir),
    timeoutMs: options.timeoutMs || 120000,
    commands: commands.map(args => ({ command, args: [...prefix, ...args] })),
  };
}

export function verifyInstalledPlugin(output, version) {
  let plugins;
  try { plugins = JSON.parse(output.trim()); } catch {
    throw new Error('WorkBuddy plugin list did not return valid JSON; installation state could not be verified');
  }
  if (!Array.isArray(plugins)) throw new Error('WorkBuddy plugin list returned an unexpected format');
  const plugin = plugins.find(entry => entry.id === PLUGIN_ID && entry.scope === 'user');
  if (!plugin || plugin.enabled !== true) throw new Error(`${PLUGIN_ID} was not reported enabled in user scope`);
  if (plugin.version !== version) {
    throw new Error(`Installed version ${plugin.version} differs from built version ${version}. Use WorkBuddy's plugin update command before reporting an upgrade complete.`);
  }
  return plugin;
}

export function verifyInstalledFiles(sourceDir, installedDir) {
  if (typeof installedDir !== 'string' || !installedDir) throw new Error('WorkBuddy did not report an installPath; installed content cannot be verified');
  const mismatches = [];
  let verifiedFiles = 0;
  const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
  const visit = relative => {
    for (const entry of readdirSync(path.join(sourceDir, relative), { withFileTypes: true })) {
      const local = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Packaged source contains an unsupported symbolic link: ${local}`);
      if (entry.isDirectory()) visit(local);
      else if (entry.isFile()) {
        const installed = path.join(installedDir, local);
        try {
          if (!lstatSync(installed).isFile() || digest(path.join(sourceDir, local)) !== digest(installed)) mismatches.push(local);
          else verifiedFiles++;
        } catch { mismatches.push(local); }
      }
    }
  };
  visit('');
  if (mismatches.length) {
    throw new Error(`Installed content differs from the built plugin (${mismatches.slice(0, 5).join(', ')}). WorkBuddy may reuse a same-version cache. Bump the plugin and marketplace entry versions, rebuild, and rerun this installer; do not report the cached build as current.`);
  }
  return { verifiedFiles };
}

export function runCommand(command, args, { env, timeoutMs, log = console.log } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const limit = 1024 * 1024;
    const append = (current, chunk) => (current + chunk.toString()).slice(-limit);
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs || 120000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (stdout.trim()) log(stdout.trim());
      if (stderr.trim()) log(stderr.trim());
      if (timedOut) reject(new Error(`WorkBuddy command timed out after ${timeoutMs || 120000} ms`));
      else if (code !== 0) reject(new Error(`WorkBuddy command failed (exit ${code}): ${args.join(' ')}`));
      else resolve({ stdout, stderr, exitCode: code });
    });
  });
}

export async function install(options = {}, dependencies = {}) {
  const log = dependencies.log || console.log;
  const plan = createPlan(options, dependencies);
  log(`WorkBuddy configuration: ${plan.configDir}`);
  log(`Built marketplace: ${plan.marketplace}`);
  if (options.dryRun) {
    log('Dry run — no processes started and no files changed.');
    for (const step of plan.commands) log(JSON.stringify({ command: step.command, args: step.args }));
    return { dryRun: true, plan, results: [] };
  }
  const results = [];
  const run = dependencies.runCommand || runCommand;
  for (const step of plan.commands) {
    results.push(await run(step.command, step.args, { env: plan.environment, timeoutMs: plan.timeoutMs, log }));
  }
  const installedPlugin = options.validateOnly ? undefined
    : verifyInstalledPlugin(results.at(-1).stdout, plan.pluginVersion);
  const contentVerification = installedPlugin
    ? verifyInstalledFiles(plan.pluginDir, installedPlugin.installPath) : undefined;
  if (contentVerification) log(`Verified ${contentVerification.verifiedFiles} installed files against the built plugin (SHA256).`);
  log(options.validateOnly
    ? 'WorkBuddy native manifest validation passed. No plugin was installed.'
    : `Installed ${PLUGIN_ID}. Start a new WorkBuddy task (restart WorkBuddy if needed), then invoke the workbuddy-rsi Skill. Keep ${plan.marketplace} available. Installation checks do not prove model-task behavior.`);
  return { dryRun: false, plan, results, installedPlugin, contentVerification };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log(HELP);
    else await install(options);
  } catch (error) {
    console.error(`Installation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
