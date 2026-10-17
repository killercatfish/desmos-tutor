import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const serverPort = Number(process.env.PORT ?? 3001);

export default defineConfig({
  root: 'web',
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: { '/api': `http://127.0.0.1:${serverPort}` },
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'web/index.html'),
        teacher: resolve(import.meta.dirname, 'web/teacher.html'),
      },
    },
  },
  plugins: [
    {
      name: 'teacher-route',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url === '/teacher' || req.url?.startsWith('/teacher?')) req.url = req.url.replace('/teacher', '/teacher.html');
          next();
        });
      },
    },
  ],
});
