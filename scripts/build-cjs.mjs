// CommonJS build for tools that still require() the package: bundles the ESM output into one .cjs file.
import { build } from 'esbuild';

await build({
  entryPoints: ['dist/esm/index.js'],
  outfile: 'dist/cjs/index.cjs',
  bundle: true,
  format: 'cjs',
  platform: 'neutral',
  target: 'es2020',
});
