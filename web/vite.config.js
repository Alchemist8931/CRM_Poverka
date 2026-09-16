/* Сборка фронта.
 *
 * Две сборки из одних и тех же исходников:
 *   vite build              → web/dist      — рабочая, ходит в API того же адреса;
 *   vite build --mode demo  → web/dist-demo — один файл с наполнением в памяти,
 *                             он же лежит в корне репозитория и открывается
 *                             на GitHub Pages без сервера.
 *
 * Обращения к API идут относительными путями (/api, /health), поэтому и в
 * разработке, и в предпросмотре они проксируются на сервер: сессионная cookie
 * помечена SameSite=Lax и на чужой адрес браузер её просто не отправит.
 */
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const API = process.env.API_ORIGIN || 'http://127.0.0.1:3000';
const proxy = { '/api': { target: API, changeOrigin: false }, '/health': { target: API, changeOrigin: false } };

export default defineConfig(({ mode }) => ({
  root: '.',
  base: './',
  // Демо-режим по умолчанию включается только в демо-сборке; в рабочей он
  // остаётся доступным через ?demo=1 — им удобно показывать экраны без базы.
  define: { __DEMO_DEFAULT__: JSON.stringify(mode === 'demo') },
  plugins: mode === 'demo' ? [viteSingleFile()] : [],
  build: {
    outDir: mode === 'demo' ? 'dist-demo' : 'dist',
    emptyOutDir: true,
    target: 'es2022',
    assetsInlineLimit: mode === 'demo' ? 100000000 : 4096,
  },
  server: { port: 5173, proxy },
  preview: { port: 4173, proxy },
}));
