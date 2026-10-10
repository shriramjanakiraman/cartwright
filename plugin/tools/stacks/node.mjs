// Node.js, JavaScript and TypeScript: package.json, lockfiles (existence only), the Node pin, frameworks, and the
// project's own build, test and lint scripts as the detected package manager runs them.

// Lockfiles in priority order; only their existence is checked, never their content.
const LOCKFILES = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['package-lock.json', 'npm'], ['npm-shrinkwrap.json', 'npm']];
// Dependencies worth naming as frameworks or tools. Anything else is left out of the profile.
const KNOWN = ['next', 'react', 'react-router', '@remix-run/react', 'vue', 'nuxt', '@angular/core', 'svelte', '@sveltejs/kit',
  'express', 'fastify', 'koa', 'hono', '@nestjs/core', 'vite', 'webpack', 'typescript', 'tailwindcss', 'jest', 'vitest', 'mocha',
  '@playwright/test', 'cypress', 'eslint', 'oxlint', '@biomejs/biome', 'prettier', 'storybook',
  'sgmf-scripts', '@salesforce/storefront-next-dev', '@salesforce/storefront-next-runtime', '@salesforce/pwa-kit-dev'];
// npm init's placeholder test script: not a real test command.
const NPM_PLACEHOLDER = /^echo "Error: no test specified" && exit 1$/;

// How a package manager runs one of the project's scripts.
export function runScript(pm, name) {
  if (pm === 'pnpm' || pm === 'yarn') return `${pm} ${name}`;
  if (pm === 'bun') return `bun run ${name}`;
  return name === 'test' ? 'npm test' : `npm run ${name}`;
}

// A pinned version in .tool-versions, e.g. "nodejs 20.11.1".
export function toolVersion(ctx, names) {
  for (const line of (ctx.text('.tool-versions') || '').split(/\r?\n/)) {
    const [tool, v] = line.trim().split(/\s+/);
    if (names.includes(tool) && v) return v;
  }
  return null;
}

export default {
  id: 'node',
  detect(ctx) {
    if (!ctx.exists('package.json')) return null;
    const pkg = ctx.json('package.json') || {};
    const deps = (k) => (pkg[k] && typeof pkg[k] === 'object' ? pkg[k] : {});
    const r = { languages: [], frameworks: [], commands: {} };

    if (ctx.exists('tsconfig.json')) r.languages.push({ value: 'TypeScript', source: 'tsconfig.json' });
    else if (deps('devDependencies').typescript || deps('dependencies').typescript) r.languages.push({ value: 'TypeScript', source: `package.json#${deps('devDependencies').typescript ? 'devDependencies' : 'dependencies'}` });
    else r.languages.push({ value: 'JavaScript', source: 'package.json' });

    for (const f of ['.nvmrc', '.node-version']) {
      const v = (ctx.text(f) || '').trim();
      if (v) { r.node = { value: v.replace(/^v/, ''), source: f }; break; }
    }
    if (!r.node && toolVersion(ctx, ['nodejs', 'node'])) r.node = { value: toolVersion(ctx, ['nodejs', 'node']), source: '.tool-versions' };
    if (!r.node && typeof pkg.engines?.node === 'string') r.node = { value: pkg.engines.node, source: 'package.json#engines.node' };

    const lock = LOCKFILES.find(([f]) => ctx.exists(f));
    if (lock) r.packageManager = { value: lock[1], source: lock[0] };
    else if (typeof pkg.packageManager === 'string' && /^(npm|pnpm|yarn|bun)@/.test(pkg.packageManager)) r.packageManager = { value: pkg.packageManager.split('@')[0], source: 'package.json#packageManager' };
    const pm = r.packageManager?.value || 'npm';

    const scripts = deps('scripts');
    for (const name of ['build', 'test', 'lint']) {
      const body = scripts[name];
      if (typeof body !== 'string' || !body.trim() || (name === 'test' && NPM_PLACEHOLDER.test(body.trim()))) continue;
      r.commands[name] = { run: runScript(pm, name), defined: body, how: 'defined', source: `package.json#scripts.${name}` };
    }
    const other = Object.keys(scripts).filter((n) => !['build', 'test', 'lint'].includes(n)).sort();
    if (other.length) r.otherScripts = { value: other, source: 'package.json#scripts' };

    for (const k of ['dependencies', 'devDependencies']) {
      for (const name of KNOWN) if (typeof deps(k)[name] === 'string' && !r.frameworks.some((f) => f.name === name)) r.frameworks.push({ name, version: deps(k)[name], source: `package.json#${k}` });
    }
    return r;
  },
};
