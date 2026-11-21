/**
 * zod schema：运行时校验入口。
 *
 * 每个 schema 都带一个"双向可赋值"断言，和对应的 interface 对齐。
 * 改接口而忘了改 schema 时，typecheck 会先炸。
 */

export * from './common.js';
export * from './gate.js';
export * from './spec.js';
export * from './agent.js';
export * from './result.js';
