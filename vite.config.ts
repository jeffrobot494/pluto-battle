import { defineConfig } from 'vite';
export default defineConfig({
  server: { host: '0.0.0.0', port: 5181, strictPort: true },
  preview: { host: '0.0.0.0', port: 4181, strictPort: true },
  build: { rollupOptions: { output: { manualChunks: { three: ['three'] } } } },
});
