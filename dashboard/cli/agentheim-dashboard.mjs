#!/usr/bin/env node
// Standalone CLI for the Agentheim dashboard — same behavior as the
// /agentheim:dashboard slash command, callable from any repo without Claude Code.
// Cross-platform: Windows (via agentheim-dashboard.cmd) and macOS/Linux (via the
// extensionless bash shim; run `chmod +x ~/.local/bin/agentheim-dashboard` once).
//
// Usage (from a project that has an .agentheim/ somewhere up from cwd):
//   agentheim-dashboard          launch (or reuse) the detached server, open browser
//   agentheim-dashboard stop     terminate the server, remove the runfile
//   agentheim-dashboard status   report whether a server is running and on which port
//
// It locates dashboard/resolve-launcher.mjs beside the cwd (when run from the
// Agentheim source repo), else in the install Claude Code registered for this
// project in ~/.claude/plugins/installed_plugins.json (project-scoped installs
// whose projectPath contains the cwd first, then user-scoped — any marketplace
// name), else in the newest semver version of the legacy plugin cache
// (~/.claude/plugins/cache/agentheim/agentheim/<version>/), then
// delegates to its run() — which spawns the real launch.mjs with cwd untouched,
// so the launcher discovers the consumer project's .agentheim/ by walking up.
// Never depends on $CLAUDE_PLUGIN_ROOT (infrastructure-010; ADR-0002 addendum).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const cacheRoot = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'agentheim', 'agentheim');

const candidates = [path.join(process.cwd(), 'dashboard', 'resolve-launcher.mjs')];

// Installs Claude Code itself recorded (mirrors lib/resolve-plugin-file.mjs's
// installedPluginRoots — this file ships standalone and cannot import lib/).
try {
  const norm = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const cwd = norm(process.cwd());
  const registry = JSON.parse(
    fs.readFileSync(path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8')
  );
  const plugins = (registry && registry.plugins) || {};
  const entries = [];
  for (const key of Object.keys(plugins)) {
    if (key.split('@')[0] !== 'agentheim') continue;
    for (const e of Array.isArray(plugins[key]) ? plugins[key] : []) {
      if (!e || typeof e.installPath !== 'string' || !e.installPath) continue;
      if (e.projectPath) {
        const pp = norm(e.projectPath);
        if (cwd !== pp && !cwd.startsWith(pp + path.sep)) continue;
      }
      entries.push(e);
    }
  }
  entries.sort((a, b) => Number(!!b.projectPath) - Number(!!a.projectPath));
  for (const e of entries) candidates.push(path.join(e.installPath, 'dashboard', 'resolve-launcher.mjs'));
} catch {
  // no/malformed registry — fall through to the legacy cache walk
}
let versions = [];
try {
  versions = fs
    .readdirSync(cacheRoot)
    .filter((n) => SEMVER.test(n))
    .sort((a, b) => {
      const A = a.match(SEMVER), B = b.match(SEMVER);
      for (let i = 1; i < 4; i++) {
        const d = +B[i] - +A[i];
        if (d) return d;
      }
      return 0;
    });
} catch {
  // no plugin cache — repo-local candidate may still hit
}
for (const v of versions) candidates.push(path.join(cacheRoot, v, 'dashboard', 'resolve-launcher.mjs'));

const resolver = candidates.find(fs.existsSync);
if (!resolver) {
  console.error(`no Agentheim dashboard resolver found under ${cacheRoot} (is the plugin installed?)`);
  process.exit(1);
}

try {
  const mod = await import(pathToFileURL(resolver).href);
  mod.run(process.argv.slice(2));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
