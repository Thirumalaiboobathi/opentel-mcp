import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    // Lets .test.tsx files (web/App.test.tsx) use JSX without pulling in
    // the full @vitejs/plugin-react pipeline for the test runner --
    // that plugin is only needed for the real `vite build`.
    jsx: 'automatic',
  },
  test: {
    environment: 'node',
  },
});
