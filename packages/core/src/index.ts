/**
 * @spec-agent/core —— 领域与执行。
 *
 * 目前只有 ports；后续按 docs/modules.md 往里填
 * store / domain / spec / org / gates / engine。
 */

export * from './trailers.js';
export * from './ports/memory.js';
export * from './ports/agent-runtime.js';
export * from './ports/shell.js';
export * from './ports/git.js';
export * from './adapters/git.js';
export * from './adapters/shell.js';
export * from './spec/index.js';
export * from './store/index.js';
export * from './domain/index.js';
export * from './engine/index.js';
export * from './artifacts.js';
export * from './model-router.js';
