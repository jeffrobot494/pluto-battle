import { defineConfig } from 'vite';
export default defineConfig({
  server: { host: '0.0.0.0', port: 5183, strictPort: true },
  preview: { host: '0.0.0.0', port: 4183, strictPort: true },
  build: { rollupOptions: { output: { manualChunks: { three: ['three'] } } } },
});
