import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  sourceSecret,
  verifySourceSignature,
} from '../../apps/server/src/integrations/source-signature.js';

describe('source signature', () => {
  const body = JSON.stringify({ title: '登录失败' });
  const secret = 'test-secret';
  const signature = `sha256=${createHmac('sha256', secret)
    .update(body)
    .digest('hex')}`;

  it('未配置 secret 时开发模式放行', () => {
    expect(verifySourceSignature({ body }).ok).toBe(true);
  });

  it('正确签名通过，错误签名拒绝', () => {
    expect(verifySourceSignature({ secret, body, signature }).ok).toBe(true);
    expect(
      verifySourceSignature({ secret, body, signature: 'sha256=bad' }).ok,
    ).toBe(false);
    expect(verifySourceSignature({ secret, body }).ok).toBe(false);
  });

  it('按 source 读取环境变量', () => {
    expect(
      sourceSecret('github', {
        SPEC_AGENT_GITHUB_WEBHOOK_SECRET: 'x',
      } as NodeJS.ProcessEnv),
    ).toBe('x');
    expect(sourceSecret('feishu', {} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});
