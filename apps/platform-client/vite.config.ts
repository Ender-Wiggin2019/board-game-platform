import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { sharedModulesPlugin } from './sharedModulesPlugin';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'PLATFORM_');
  const target = env.PLATFORM_DEV_BACKEND_URL || 'http://127.0.0.1:3000';
  return {
    publicDir: false,
    plugins: [react(), sharedModulesPlugin()],
    resolve: {
      dedupe: [
        'react',
        'react-dom',
        'react-i18next',
        'i18next',
        '@board-game/client',
        '@board-game/components',
        '@board-platform/client',
      ],
    },
    build: { manifest: true },
    server: {
      host: '127.0.0.1',
      proxy: {
        '/api': { target, changeOrigin: true },
        '/socket.io': { target, ws: true, changeOrigin: true },
      },
    },
  };
});
