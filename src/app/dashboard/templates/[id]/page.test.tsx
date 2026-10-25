import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The test transform compiles JSX with the classic runtime, which the page expects in scope.
(globalThis as { React?: typeof React }).React = React;

const mocks = vi.hoisted(() => ({ template: null as unknown as Record<string, unknown> }));

vi.mock('next/navigation', () => ({ notFound: vi.fn(), redirect: vi.fn() }));
vi.mock('@/lib/auth/session', () => ({ getSession: async () => ({ user: { id: 'u1' }, orgId: 'org1', role: 'ADMIN' }) }));
vi.mock('@/lib/templates/service', () => ({ getTemplate: async () => mocks.template }));
vi.mock('@/app/(auth)/logout/actions', () => ({ logoutAction: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { envelope: { findUnique: async () => null } } }));
vi.mock('@/lib/env', () => ({ getEnv: () => ({ PUBLIC_URL: 'https://docs.example.edu' }) }));
vi.mock('./form', () => ({ InstantiateForm: () => null }));
vi.mock('./public-form/panel', () => ({ PublicFormPanel: () => null }));

import TemplateDetailPage from './page';

const item = (id: string, title: string, canonicalRefusal: string | null) => ({
  id, title, pageCount: 1, documentFile: { canonicalRefusal },
});

async function render(items: ReturnType<typeof item>[]): Promise<string> {
  mocks.template = { id: 'tpl1', title: 'Contract template', routingMode: 'PARALLEL', items, recipients: [] };
  return renderToStaticMarkup(await TemplateDetailPage({ params: Promise.resolve({ id: 'tpl1' }) }));
}

beforeEach(() => vi.clearAllMocks());

describe('template page', () => {
  it('flags a document the canonicalizer refused, with the reason', async () => {
    const html = await render([item('i1', 'Marked.pdf', 'hidden_layers'), item('i2', 'Fine.pdf', null)]);

    expect(html).toContain(
      'This document can&#x27;t be used for signing: This PDF has hidden layers, so the signed copy could show content the signer never saw. Print it to a new PDF with the layers you want, and upload again. Upload a replacement to use this template.',
    );
    expect(html.match(/can&#x27;t be used for signing/g)).toHaveLength(1);
  });

  it('shows no flag when no document was refused', async () => {
    expect(await render([item('i1', 'Fine.pdf', null)])).not.toContain('used for signing');
  });

  it('reads an unknown stored refusal as unreadable', async () => {
    expect(await render([item('i1', 'Odd.pdf', 'no_such_key')])).toContain('PDF file looks corrupted or unreadable');
  });
});
