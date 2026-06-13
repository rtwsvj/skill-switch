import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Tauri webview 从 tauri://localhost 加载,资源必须用相对路径;
  // 默认 base '/' 会让打包后引用 /assets/… 解析失败 → 白屏(dev 正常)。
  base: './',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
});
