import { defineConfig } from 'tsdown'
import { readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'

// Read the manifest from cwd: `pnpm run build` runs here.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

// Host half: production/peer deps stay imports at runtime (resolved from the
// profile's hoisted installation); everything else (local code) inlines.
// CRITICAL: all @deepseek-ai/* packages must stay external — inlining a
// package that imports @deepseek-ai/cordis creates a second cordis instance
// (pnpm store's 4.0.2 vs the fork's 4.0.2), breaking the event bus.
const productionDeps = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
])
const isExternal = (specifier: string): boolean =>
  specifier.startsWith('@deepseek-ai/')
  || productionDeps.has(specifier)
  || [...productionDeps].some(name => {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`^${esc}(/|$)`).test(specifier)
  })

export default defineConfig([
  {
    name: pkg.name,
    entry: { index: 'src/index.ts', startup: 'src/startup.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,
    clean: true,
    deps: {
      neverBundle: isExternal,
      alwaysBundle: (specifier: string) => !isBuiltin(specifier) && !isExternal(specifier),
    },
  },
])
