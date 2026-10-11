// @ts-check
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig } from 'eslint/config';
import root from '../../eslint.config.js';

// ESLint uses the config file nearest to each linted file, so the dashboard adds the React
// rules here (plan 01 owns the root config).
export default defineConfig(root, {
  files: ['**/*.{ts,tsx}'],
  extends: [reactHooks.configs.flat['recommended-latest']],
});
