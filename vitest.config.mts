import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    projects: [
      {
        test: {
          name: 'main',
          globals: true,
          environment: 'node',
          include: ['tests/main/**/*.test.ts', 'tests/*.test.ts']
        }
      },
      {
        test: {
          name: 'renderer',
          globals: true,
          environment: 'jsdom',
          include: ['tests/renderer/**/*.test.{ts,tsx}']
        }
      }
    ]
  }
})
