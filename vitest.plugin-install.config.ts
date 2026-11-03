import { defineConfig } from 'vitest/config';
import sourceConfig from './vitest.config.js';

export default defineConfig({
  ...sourceConfig,
  test: {
    ...sourceConfig.test,
    include: ['tests/packaging/**/*.packaging.ts'],
  },
});
