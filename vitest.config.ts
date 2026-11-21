import { defineConfig } from 'vitest/config';

/**
 * 覆盖率门槛按"已完成模块"逐个纳入。
 * 新模块完成时，把它的 src 目录加进 include，并把门槛抬到实际水平。
 */
export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'tests/**/*.test.ts'],
    // 集成测试会启动 server、SQLite 和 git；并行 worker 满载时 5s 默认值会误伤。
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: {
      provider: 'v8',
      include: [
        'packages/core/src/spec/**/*.ts',
        'packages/core/src/store/**/*.ts',
        'packages/core/src/domain/**/*.ts',
        'packages/core/src/engine/**/*.ts',
        'packages/core/src/adapters/**/*.ts',
        'packages/adapters-claude/src/**/*.ts',
        'packages/kernel/src/**/*.ts',
      ],
      exclude: [
        '**/*.test.ts',
        '**/index.ts',
        '**/__fixtures__/**',
        // 纯类型文件，没有运行时代码
        '**/domain/drafts.ts',
        '**/domain/snapshots.ts',
        '**/domain/state.ts',
      ],
      reporter: ['text'],
      thresholds: {
        statements: 95,
        branches: 90,
        functions: 97.5,
        lines: 95,
        // 引擎含大量错误路径与恢复分支，按 testing.md 的编排模块标准放宽
        'packages/core/src/engine/**': {
          statements: 85,
          branches: 80,
          functions: 90,
          lines: 85,
        },
        'packages/adapters-claude/**': {
          statements: 75,
          branches: 65,
          functions: 80,
          lines: 75,
        },
      },
    },
  },
});
