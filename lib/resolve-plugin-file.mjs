// Generalized env-independent plugin-file resolver (infrastructure-010's resolver,
// generalized beyond `dashboard/launch.mjs` — agentic-workflow-k5n8f).
//
// WHY THIS EXISTS
// `dashboard/resolve-launcher.mjs` proved the pattern for locating ONE specific
// in-plugin file (`dashboard/launch.mjs`) without trusting `$CLAUDE_PLUGIN_ROOT`
// (empty in an installed plugin's command Bash context — infrastructure-010). The
// `task-lifecycle` CLI (ADR-0038) needs the identical pattern for a DIFFERENT
// in-plugin file (`lib/task-lifecycle-cli.mjs`), invoked from skill prose rather
// than a slash command. Rather than duplicate the walk, this module generalizes
// it to resolve an arbitrary `relPath` inside the plugin, and
// `dashboard/resolve-launcher.mjs` now delegates to it (behavior-preserving).
//
// MECHANISM (stdlib only, zero deps — ADR-0002) — unchanged from infrastructure-010:
//   1. Derive the plugin cache root from os.homedir() (never read the raw env
//      vars): <home>/.claude/plugins/cache/agentheim/agentheim.
//   2. Pick the newest version subdir by SEMVER maximum (numeric per field, not
//      lexical: 0.8.10 > 0.8.9 > 0.8.3), ignoring non-semver dir names.
//   3. Resolve <version>/<relPath>; require it to exist. Fail LOUDLY — never a
//      `.`-relative fallback — when nothing is found.
//   3b. BEFORE the cache walk, consult Claude Code's own install registry
//      (<home>/.claude/plugins/installed_plugins.json): every `agentheim@<any
//      marketplace>` entry whose `projectPath` contains the cwd (project/local
//      scope) wins, then user-scoped entries; entries scoped to another project
//      are skipped. This is what lets a fork installed from a differently-named
//      marketplace (cache/<that-marketplace>/agentheim/) resolve to its own code
//      instead of a stale upstream copy in cache/agentheim/agentheim/. The
//      semver-max cache walk stays as the fallback when the registry is missing.
//   4. Repo-local short-circuit: when running from the Agentheim repo itself (this
//      module lives at <repo>/lib/resolve-plugin-file.mjs), <repo>/<relPath> is
//      checked first via `import.meta.url`, skipping the cache walk entirely.
//
// $CLAUDE_PLUGIN_ROOT is treated as an OPTIONAL fast-path only (forward-compatible
// if Claude Code ever populates it reliably); correctness NEVER depends on it.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * The plugin cache root for Agentheim, derived purely from a home directory.
 * Works for both a win32-shaped homedir (C:\Users\x) and a POSIX one (/home/x):
 * path.join normalizes separators for the running platform.
 * @param {string} homedir
 * @returns {string} <home>/.claude/plugins/cache/agentheim/agentheim
 */
export function cacheRoot(homedir) {
  return path.join(homedir, '.claude', 'plugins', 'cache', 'agentheim', 'agentheim');
}

/**
 * Compare two semver strings numerically. Returns >0 if a is newer, <0 if older.
 * Non-throwing helper used by pickNewestVersion.
 */
function compareSemver(a, b) {
  const pa = a.match(SEMVER), pb = b.match(SEMVER);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Pick the SEMVER-maximum dir name from a list, ignoring any name that isn't a
 * bare x.y.z. Returns null when none qualify. Numeric per-field comparison avoids
 * the lexical trap where "0.8.10" sorts before "0.8.9".
 * @param {string[]} dirNames
 * @returns {string|null}
 */
export function pickNewestVersion(dirNames) {
  const versions = dirNames.filter((n) => SEMVER.test(n));
  if (versions.length === 0) return null;
  return versions.reduce((best, v) => (compareSemver(v, best) > 0 ? v : best));
}

/**
 * Resolve the path to the newest cached `<version>/<relPath>` under a cache root.
 * Walks version dirs newest-first and returns the first whose `<version>/<relPath>`
 * actually exists (so a half-written newer version dir can't break resolution).
 * Fails LOUDLY — never returns a `.`-relative fallback — when nothing is found.
 * @param {string} root     the agentheim/agentheim cache root (see cacheRoot)
 * @param {string} relPath  a forward-slash-separated path relative to the plugin
 *                          root, e.g. `dashboard/launch.mjs` or
 *                          `lib/task-lifecycle-cli.mjs` (normalized per-platform
 *                          via path.join internally; kept forward-slash in
 *                          messages for readability)
 * @param {string} [label]  human label used in the fail-loud message; defaults to
 *                          `relPath` itself (e.g. resolveLauncher passes `launcher`)
 * @returns {string} absolute path to the resolved file
 */
export function resolvePluginFile(root, relPath, label = relPath) {
  let names = [];
  try {
    names = readdirSync(root).filter((n) => {
      try {
        return statSync(path.join(root, n)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    names = [];
  }

  const versions = names
    .filter((n) => SEMVER.test(n))
    .sort((a, b) => compareSemver(b, a)); // newest first

  for (const v of versions) {
    const candidate = path.join(root, v, relPath);
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    `no cached ${label} found under ${root} — searched for ` +
      `<version>/${relPath} in version dirs [${versions.join(', ') || 'none'}]. ` +
      `Is the Agentheim plugin installed? (Do NOT fall back to a project-relative path.)`
  );
}

/**
 * Plugin roots Claude Code itself recorded for Agentheim in
 * `<home>/.claude/plugins/installed_plugins.json`, ordered for `cwd`:
 * project/local-scoped installs whose `projectPath` is `cwd` or an ancestor of it
 * first, then user-scoped installs (no `projectPath`). Installs scoped to some
 * other project are excluded. Loss-tolerant: a missing or malformed registry
 * yields `[]`, never throws. Path comparison is case-insensitive on win32.
 * @param {string} homedir
 * @param {string} cwd
 * @param {string} [platform]  defaults to process.platform (injectable for tests)
 * @returns {string[]} install paths, best match first
 */
export function installedPluginRoots(homedir, cwd, platform = process.platform) {
  const norm = (s) => (platform === 'win32' ? s.toLowerCase() : s);
  const sep = platform === 'win32' ? '\\' : '/';
  let plugins;
  try {
    const registry = JSON.parse(
      readFileSync(path.join(homedir, '.claude', 'plugins', 'installed_plugins.json'), 'utf8')
    );
    plugins = (registry && registry.plugins) || {};
  } catch {
    return [];
  }
  const w = norm(cwd);
  const entries = [];
  for (const key of Object.keys(plugins)) {
    if (key.split('@')[0] !== 'agentheim') continue;
    const list = Array.isArray(plugins[key]) ? plugins[key] : [];
    for (const e of list) {
      if (!e || typeof e.installPath !== 'string' || !e.installPath) continue;
      if (e.projectPath) {
        const pp = norm(e.projectPath);
        if (w !== pp && !w.startsWith(pp.endsWith(sep) ? pp : pp + sep)) continue;
      }
      entries.push(e);
    }
  }
  entries.sort((a, b) => Number(!!b.projectPath) - Number(!!a.projectPath));
  return entries.map((e) => e.installPath);
}

/**
 * Full resolution: prefer the repo-local file (Agentheim's own repo, where
 * `<relPath>` sits at the repo root beside this module's `lib/` dir), else the
 * install Claude Code registered for the cwd (see installedPluginRoots), else
 * the newest cached one.
 * @param {string} relPath        forward-slash path relative to the plugin/repo
 *                                root, e.g. `dashboard/launch.mjs`
 * @param {object} [opts]
 * @param {string} [opts.moduleDir]     dir of this module (defaults to
 *                                      `import.meta.url`'s dirname — normally
 *                                      `<repo>/lib`)
 * @param {string} [opts.repoRoot]      repo root override; defaults to
 *                                      `path.dirname(moduleDir)` (this module
 *                                      always lives exactly one level under the
 *                                      repo root)
 * @param {string} [opts.repoLocalPath] full override of the repo-local candidate
 *                                      path, bypassing the moduleDir/repoRoot
 *                                      derivation entirely — for callers (like
 *                                      `dashboard/resolve-launcher.mjs`) whose own
 *                                      repo-local neighbor lives beside THEIR
 *                                      module, not beside this one
 * @param {string} [opts.homedir]       home dir (defaults to os.homedir())
 * @param {string} [opts.cwd]           working dir used to match project-scoped
 *                                      installs (defaults to process.cwd())
 * @param {string} [opts.label]         human label for the fail-loud message
 * @returns {string} absolute path to the resolved file
 */
export function locatePluginFile(relPath, opts = {}) {
  const moduleDir = opts.moduleDir || path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = opts.repoRoot || path.dirname(moduleDir);
  const repoLocal = opts.repoLocalPath || path.join(repoRoot, relPath);
  if (existsSync(repoLocal)) return repoLocal;
  const homedir = opts.homedir || os.homedir();
  for (const root of installedPluginRoots(homedir, opts.cwd || process.cwd())) {
    const candidate = path.join(root, relPath);
    if (existsSync(candidate)) return candidate;
  }
  return resolvePluginFile(cacheRoot(homedir), relPath, opts.label);
}
