/**
 * OpenAI 兼容 Embedding Provider。
 * 配置 SPEC_AGENT_EMBEDDING_URL / _API_KEY / _MODEL 后启用；
 * 未配置时由 WorkMemoryStore 回退到本地哈希向量。
 */

export type EmbeddingProvider = {
  model: string;
  embed(texts: string[]): Promise<number[][]>;
};

class OpenAIEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly options: {
      baseUrl: string;
      apiKey?: string;
      model: string;
      fetchImpl?: typeof fetch;
    },
  ) {}

  get model(): string {
    return this.options.model;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(
      `${this.options.baseUrl.replace(/\/$/, '')}/embeddings`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.options.apiKey
            ? { authorization: `Bearer ${this.options.apiKey}` }
            : {}),
        },
        body: JSON.stringify({
          model: this.options.model,
          input: texts,
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok) {
      throw new Error(`embedding provider ${response.status}`);
    }
    const payload = (await response.json()) as {
      data?: Array<{ embedding?: number[]; index?: number }>;
    };
    const vectors = [...(payload.data ?? [])]
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((item) => item.embedding ?? []);
    if (vectors.length !== texts.length || vectors.some((v) => v.length === 0)) {
      throw new Error('embedding provider 返回不完整');
    }
    return vectors;
  }
}

export function createEmbeddingProvider(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingProvider | undefined {
  if (!env.SPEC_AGENT_EMBEDDING_URL) return undefined;
  return new OpenAIEmbeddingProvider({
    baseUrl: env.SPEC_AGENT_EMBEDDING_URL,
    apiKey: env.SPEC_AGENT_EMBEDDING_API_KEY,
    model: env.SPEC_AGENT_EMBEDDING_MODEL ?? 'text-embedding-3-small',
  });
}

