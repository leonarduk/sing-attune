import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    exclude: [...configDefaults.exclude, 'tests/e2e/**'],
  },
});
