/**
 * 外部事件源签名。
 *
 * GitHub: X-Hub-Signature-256: sha256=<hex>
 * 其他来源: X-Spec-Agent-Signature: sha256=<hex>
 * 未配置 secret 时开发模式直接放行。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export type SourceSignatureResult = {
  ok: boolean;
  reason?: string;
};

export function sourceSecret(
  source: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env[`SPEC_AGENT_${source.toUpperCase()}_WEBHOOK_SECRET`] || undefined;
}

export function verifySourceSignature(input: {
  secret?: string;
  body: string;
  signature?: string;
}): SourceSignatureResult {
  if (!input.secret) return { ok: true };
  if (!input.signature) {
    return { ok: false, reason: '缺少 Webhook 签名' };
  }
  const expected = `sha256=${createHmac('sha256', input.secret)
    .update(input.body, 'utf8')
    .digest('hex')}`;
  const providedBuffer = Buffer.from(input.signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return { ok: false, reason: 'Webhook 签名不匹配' };
  }
  return { ok: true };
}
