import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  SegmentedControl,
  Textarea,
  Dialog,
  Tag,
  Tooltip,
  Menu,
} from '@spec-agent/ui';

describe('@spec-agent/ui primitives', () => {
  it('renders primary and ghost buttons with semantics', () => {
    const primary = renderToStaticMarkup(
      createElement(Button, {
        variant: 'primary',
        loading: true,
        children: '保存',
      }),
    );
    expect(primary).toContain('ui-button--primary');
    expect(primary).toContain('aria-busy="true"');
    expect(primary).toContain('disabled');

    const ghost = renderToStaticMarkup(
      createElement(Button, {
        variant: 'ghost',
        type: 'submit',
        children: '取消',
      }),
    );
    expect(ghost).toContain('ui-button--ghost');
    expect(ghost).toContain('type="submit"');
  });

  it('renders fields and form controls with ui classes', () => {
    const markup = renderToStaticMarkup(
      createElement(Field, {
        label: '名称',
        hint: '最多 80 字',
        children: createElement(Input, { placeholder: '子项目名称' }),
      }),
    );
    expect(markup).toContain('ui-field__label');
    expect(markup).toContain('ui-input');
    expect(markup).toContain('子项目名称');
    expect(markup).toContain('最多 80 字');
    expect(renderToStaticMarkup(createElement(Textarea, {}))).toContain(
      'ui-textarea',
    );
  });

  it('renders segmented options and pressed state', () => {
    const onChange = vi.fn();
    const markup = renderToStaticMarkup(
      createElement(SegmentedControl, {
        value: 'qa',
        ariaLabel: '模式',
        options: [
          { value: 'qa', label: '问答' },
          { value: 'task', label: '任务' },
        ],
        onChange,
      }),
    );
    expect(markup).toContain('ui-segmented');
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain('问答');
  });

  it('renders badge and empty state', () => {
    const markup = renderToStaticMarkup(
      createElement(
        'div',
        null,
        createElement(Badge, { tone: 'success', children: '已加入' }),
        createElement(Tag, { tone: 'info', children: '规划中' }),
        createElement(EmptyState, {
          title: '还没有会话',
          description: '创建第一个会话',
        }),
      ),
    );
    expect(markup).toContain('ui-badge--success');
    expect(markup).toContain('ui-tag');
    expect(markup).toContain('规划中');
    expect(markup).toContain('ui-empty');
    expect(markup).toContain('还没有会话');
  });

  it('closed dialog renders nothing before portal mounting', () => {
    const markup = renderToStaticMarkup(
      createElement(Dialog, {
        open: false,
        onClose: () => undefined,
        title: '设置',
        children: createElement('div', null, '内容'),
      }),
    );
    expect(markup).toBe('');
  });

  it('tooltip and menu render closed anchors without open overlays', () => {
    const tooltip = renderToStaticMarkup(
      createElement(Tooltip, {
        label: '提示',
        children: createElement(Button, { children: '按钮' }),
      }),
    );
    expect(tooltip).toContain('ui-tooltip-anchor');
    expect(tooltip).not.toContain('role="tooltip"');

    const menu = renderToStaticMarkup(
      createElement(Menu, {
        label: '项目操作',
        trigger: createElement('span', null, '⋯'),
        items: [{ label: '归档项目', onSelect: () => undefined }],
      }),
    );
    expect(menu).toContain('ui-menu-trigger');
    expect(menu).not.toContain('role="menu"');
  });
});
