import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      // Each package with a vitest.config.ts is one project.
      'packages/*/vitest.config.ts',
      {
        test: {
          name: 'scripts',
          environment: 'node',
          include: ['scripts/**/*.test.ts'],
        },
      },
    ],
  },
});
