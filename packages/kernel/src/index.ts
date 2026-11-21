/**
 * @spec-agent/kernel —— 零业务依赖的地基。
 *
 * 这里只有：id、时钟、错误、脱敏、日志、配置。
 * 不 import 任何业务模块，也不做 I/O 之外的事情。
 */

export * from './ids.js';
export * from './clock.js';
export * from './errors.js';
export * from './redact.js';
export * from './logger.js';
export * from './config.js';
