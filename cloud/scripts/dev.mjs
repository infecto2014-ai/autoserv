import { build } from 'esbuild';

await build({
  entryPoints: ['tests/dev-server.ts'],
  outfile: '.sites-runtime/dev-server.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  banner: { js: 'const devEntryUrl = new URL("../tests/dev-server.ts", import.meta.url).href;' },
  define: { 'import.meta.url': 'devEntryUrl' },
});
await import('../.sites-runtime/dev-server.mjs');
