import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const fromSrc = (path) => fileURLToPath(new URL(`./src/${path}`, import.meta.url));

export default defineConfig(({ mode }) => {
  // Keep the existing REACT_APP_* variable names so .env files, Docker and
  // CI settings work unchanged. loadEnv reads .env* files plus process.env.
  const env = loadEnv(mode, process.cwd(), 'REACT_APP_');
  const processEnv = {
    ...env,
    NODE_ENV: mode === 'production' ? 'production' : 'development',
    PUBLIC_URL: '',
  };

  return {
    plugins: [react()],

    // Replace `process.env` in app code with the values above at build time
    // (what CRA did). Tests use the real process.env instead, so they can set
    // variables at runtime.
    define:
      mode === 'test'
        ? {}
        : {
            'process.env': JSON.stringify(processEnv),
          },

    server: {
      host: true,
      port: 3000,
      strictPort: true,
      // docker-compose mounts src/ and sets CHOKIDAR_USEPOLLING for hot reload.
      watch: { usePolling: process.env.CHOKIDAR_USEPOLLING === 'true' },
    },
    preview: { host: true, port: 3000, strictPort: true },

    build: {
      // Same output folder as CRA so deploy scripts don't change.
      outDir: 'build',
      sourcemap: true,
    },

    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/setupTests.js'],
      include: ['src/**/*.{test,spec}.{js,jsx}', 'src/**/__tests__/**/*.{js,jsx}'],
      // CRA's Jest preset reset mock state between tests; keep that behaviour.
      mockReset: true,
      css: false,
      alias: {
        '@sentry/react': fromSrc('__mocks__/@sentry/react.js'),
        '@ledgerhq/hw-transport-webusb': fromSrc('__mocks__/@ledgerhq/hw-transport-webusb.js'),
        '@ledgerhq/hw-app-str': fromSrc('__mocks__/@ledgerhq/hw-app-str.js'),
      },
      coverage: {
        provider: 'v8',
        // Jest always wrote coverage; keep that when some tests fail.
        reportOnFailure: true,
        include: ['src/**/*.{js,jsx}'],
        exclude: ['src/**/*.test.{js,jsx}', 'src/**/__tests__/**', 'src/__mocks__/**'],
      },
    },
  };
});
