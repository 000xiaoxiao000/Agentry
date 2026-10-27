import { defineConfig } from 'vite';

// 前端以 src/ 为根，构建产物输出到 ../dist（对应 tauri.conf.json 的 frontendDist）。
export default defineConfig({
  root: 'src',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
});
