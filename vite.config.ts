import path from 'node:path';
import { defineConfig } from 'vite';
import { rundotGameLibrariesPlugin } from '@series-inc/rundot-game-sdk/vite';

export default defineConfig(({ mode }) => ({
  // RUN hosts games under a versioned subpath, so asset URLs must be relative.
  base: './',
  // The RUN host provides three as a shared library; this externalizes it from the bundle.
  plugins: mode === 'browser-test' ? [] : [rundotGameLibrariesPlugin()],
  resolve: {
    alias: {
      // three doesn't expose ./package.json in its exports map; the libraries plugin reads it to detect the version.
      'three/package.json': path.resolve(import.meta.dirname, 'node_modules/three/package.json'),
    },
  },
  // The RUN SDK uses top-level await.
  esbuild: { target: 'es2022' },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
  server: { host: '0.0.0.0', port: 5181, strictPort: true },
  preview: { host: '0.0.0.0', port: 4181, strictPort: true },
  build: { target: 'es2022' },
}));
