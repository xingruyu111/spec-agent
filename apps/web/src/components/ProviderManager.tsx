import { useEffect, useState } from 'react';
import { Button, Checkbox, Dialog, IconButton, Input, Select } from '@spec-agent/ui';
import { api, type ProviderSettings } from '../api.js';

type ProviderModelDraft = {
  id: string;
  contextWindow: string;
  autoCompact: boolean;
};

type ProviderDraft = {
  id: string;
  name: string;
  protocol: 'anthropic' | 'openai';
  baseUrl: string;
  models: ProviderModelDraft[];
  authToken: string;
  showToken: boolean;
  hasToken: boolean;
  tokenHint: string;
};

export function ProviderManager({
  open,
  settings,
  onClose,
  onSaved,
}: {
  open: boolean;
  settings: ProviderSettings | null;
  onClose: () => void;
  onSaved: (settings: ProviderSettings) => void;
}) {
  const [providers, setProviders] = useState<ProviderDraft[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (open) setSaved(false);
  }, [open]);

  useEffect(() => {
    if (!open || !settings) return;
    const next = settings.providers.map(toDraft);
    setProviders(next);
    setSelectedId(next[0]?.id ?? '');
    setError('');
  }, [open, settings]);

  const selected = providers.find((provider) => provider.id === selectedId) ?? providers[0];
  const taskProvider =
    providers.find((provider) => modelIds(provider.models).length > 0) ??
    providers[0];
  const taskModel = modelIds(taskProvider?.models ?? [])[0] ?? '';

  if (!open) return null;

  const updateSelected = (patch: Partial<ProviderDraft>): void => {
    if (!selected) return;
    setSaved(false);
    setProviders((current) => current.map((provider) =>
      provider.id === selected.id ? { ...provider, ...patch } : provider,
    ));
  };

  const updateModel = (index: number, patch: Partial<ProviderModelDraft>): void => {
    if (!selected) return;
    updateSelected({
      models: selected.models.map((model, position) =>
        position === index ? { ...model, ...patch } : model,
      ),
    });
  };

  const addProvider = (): void => {
    const id = uniqueProviderId(providers);
    setProviders((current) => [...current, {
      id,
      name: '新供应商',
      protocol: 'anthropic',
      baseUrl: '',
      models: [],
      authToken: '',
      showToken: false,
      hasToken: false,
      tokenHint: '',
    }]);
    setSelectedId(id);
    setSaved(false);
  };

  const removeSelected = (): void => {
    if (!selected || providers.length <= 1) return;
    const next = providers.filter((provider) => provider.id !== selected.id);
    setProviders(next);
    setSelectedId(next[0]?.id ?? '');
  };

  const save = async (): Promise<void> => {
    setError('');
    setSaved(false);
    if (providers.some((provider) => !provider.baseUrl.trim())) {
      setError('每个供应商都需要 Base URL');
      return;
    }
    if (providers.some((provider) => provider.models.length === 0 || provider.models.some((model) => !model.id.trim()))) {
      setError('每个供应商至少需要一个模型');
      return;
    }
    if (!taskProvider || !taskModel) {
      setError('至少配置一个带模型的供应商');
      return;
    }
    setBusy(true);
    try {
      await api.saveProvider({
        defaultProviderId: taskProvider.id,
        model: taskModel,
        providers: providers.map((provider) => ({
          id: provider.id,
          name: provider.name.trim() || provider.id,
          protocol: provider.protocol,
          baseUrl: provider.baseUrl.trim(),
          models: provider.models.map((model) => ({
            id: model.id.trim(),
            ...(model.contextWindow.trim() ? { contextWindow: Number(model.contextWindow) } : {}),
            autoCompact: model.autoCompact,
          })),
          authToken: provider.authToken.trim(),
        })),
      });
      const refreshed = await api.provider(true);
      onSaved(refreshed);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="供应商与模型"
      description="每个供应商独立配置凭证和模型，保存后新任务立即生效"
      width={920}
      maxWidth={920}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            loading={busy}
            onClick={() => void save()}
          >
            {busy ? '保存中…' : '保存配置'}
          </Button>
        </>
      }
    >
      <div className="provider-manager-body">
          <aside className="provider-registry-list" aria-label="供应商列表">
            <div className="provider-registry-head">
              <span>供应商</span>
              <IconButton
                label="添加供应商"
                size="sm"
                className="chat-icon-btn"
                onClick={addProvider}
              >
                +
              </IconButton>
            </div>
            {providers.map((provider) => (
              <Button variant="plain"
                key={provider.id}
                className={selected?.id === provider.id ? 'active' : ''}
                onClick={() => setSelectedId(provider.id)}
              >
                <span>
                  <b>{provider.name || provider.id}</b>
                  <small>{provider.protocol} · {provider.models.length} 个模型</small>
                </span>
              </Button>
            ))}
          </aside>

          {selected ? (
            <div className="provider-editor">
              <div className="provider-editor-title">
                <label>
                  显示名称
                  <Input value={selected.name} onChange={(event) => updateSelected({ name: event.target.value })} />
                </label>
                <code>{selected.id}</code>
              </div>
              <div className="provider-form-grid">
                <label>
                  协议
                  <Select
                    value={selected.protocol}
                    onChange={(event) => updateSelected({ protocol: event.target.value as 'anthropic' | 'openai' })}
                  >
                    <option value="anthropic">Anthropic Messages</option>
                    <option value="openai">OpenAI Compatible</option>
                  </Select>
                </label>
                <label>
                  Base URL
                  <Input
                    placeholder={selected.protocol === 'anthropic' ? 'https://api.deepseek.com/anthropic' : 'https://api.openai.com'}
                    value={selected.baseUrl}
                    onChange={(event) => updateSelected({ baseUrl: event.target.value })}
                  />
                </label>
              </div>
              <label>
                API Key
                <div className="provider-secret-field">
                  <Input
                    type={selected.showToken ? 'text' : 'password'}
                    autoComplete="off"
                    placeholder="输入供应商 API Key"
                    value={selected.authToken}
                    onChange={(event) => updateSelected({ authToken: event.target.value })}
                  />
                  <IconButton
                    label={selected.showToken ? '隐藏 API Key' : '显示 API Key'}
                    size="sm"
                    className="provider-secret-toggle"
                    onClick={() => updateSelected({ showToken: !selected.showToken })}
                  >
                    <EyeIcon off={selected.showToken} />
                  </IconButton>
                </div>
              </label>
              <div className="provider-model-list">
                <div className="provider-model-list-head">
                  <span>模型</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => updateSelected({
                      models: [...selected.models, { id: '', contextWindow: '', autoCompact: true }],
                    })}
                  >
                    + 添加模型
                  </Button>
                </div>
                {selected.models.map((model, index) => (
                  <div className="provider-model-row" key={index}>
                    <Input
                      aria-label="模型 ID"
                      placeholder="deepseek-chat"
                      value={model.id}
                      onChange={(event) => updateModel(index, { id: event.target.value })}
                    />
                    <label>
                      上下文
                      <Input
                        type="number"
                        min="1000"
                        max="10000000"
                        step="1000"
                        placeholder="200000"
                        value={model.contextWindow}
                        onChange={(event) => updateModel(index, { contextWindow: event.target.value })}
                      />
                    </label>
                    <label className="provider-model-compact">
                      <Checkbox
                        checked={model.autoCompact}
                        onChange={(event) => updateModel(index, { autoCompact: event.target.checked })}
                      />
                      自动压缩
                    </label>
                    <IconButton
                      label="删除模型"
                      size="sm"
                      onClick={() => updateSelected({
                        models: selected.models.filter((_, position) => position !== index),
                      })}
                    >
                      ×
                    </IconButton>
                  </div>
                ))}
                <small>上下文单位是 token，例如 200000 或 1000000；自动压缩默认开启。</small>
              </div>
              <Button
                variant="ghost"
                className="provider-delete"
                onClick={removeSelected}
                disabled={providers.length <= 1}
              >
                删除当前供应商
              </Button>
            </div>
          ) : (
            <div className="empty">添加一个供应商开始配置。</div>
          )}
        </div>

        <details className="provider-gateway">
          <summary>统一中转地址</summary>
          <p>Claude Code / Agent SDK 只需配置一个地址，模型名前加供应商 id 即可路由。</p>
          <code>Anthropic: {window.location.origin}/api/llm/anthropic</code>
          <code>OpenAI: {window.location.origin}/api/llm/openai</code>
          <small>
            模型示例：{taskProvider?.id || 'provider'}/{taskModel || 'model'}。流式响应和取消会透传。
          </small>
        </details>

        {error ? <div className="error provider-manager-error">{error}</div> : null}
        {saved ? <div className="provider-saved provider-manager-error">已保存，新任务会使用新的供应商配置。</div> : null}
    </Dialog>
  );
}

function toDraft(provider: ProviderSettings['providers'][number]): ProviderDraft {
  return {
    id: provider.id,
    name: provider.name,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    models: provider.models.map((model) => ({
      id: model.id,
      contextWindow: model.contextWindow ? String(model.contextWindow) : '',
      autoCompact: model.autoCompact ?? true,
    })),
    authToken: provider.authToken ?? '',
    showToken: false,
    hasToken: provider.hasToken,
    tokenHint: provider.tokenHint,
  };
}

function modelIds(models: ProviderModelDraft[]): string[] {
  return Array.from(new Set(models.map((model) => model.id.trim()).filter(Boolean)));
}

function uniqueProviderId(providers: ProviderDraft[]): string {
  let index = providers.length + 1;
  while (providers.some((provider) => provider.id === `provider-${index}`)) index += 1;
  return `provider-${index}`;
}

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
      <circle cx="12" cy="12" r="2.5" />
      {off ? <path d="m3 3 18 18" /> : null}
    </svg>
  );
}


