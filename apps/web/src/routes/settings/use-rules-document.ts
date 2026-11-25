import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { useDraft } from '../../drafts/index.js';
import {
  isVersionConflict,
  loadDocument,
  saveDocument,
  usePage,
  type DocumentName,
  type LoadedDocument,
  type Page,
} from '../../pages/index.js';

export interface RulesLoad {
  readonly page: Page | null;
  readonly offered: boolean;
  readonly loaded: LoadedDocument | undefined;
  readonly failed: boolean;
  reload(): Promise<unknown>;
}

export function useRulesLoad(name: DocumentName, feature: string): RulesLoad {
  const page = usePage();
  const offered = page?.features.includes(feature) === true;
  const query = useQuery({
    queryKey: [...(page?.base ?? []), 'rules', name],
    enabled: page !== null && offered,
    gcTime: 0,
    queryFn: async (): Promise<LoadedDocument> =>
      page === null ? { version: 0, text: null } : loadDocument(page, name),
  });
  return {
    page,
    offered,
    loaded: query.data,
    failed: query.isError,
    reload: () => query.refetch(),
  };
}

export interface RulesEditor<Rule> {
  readonly rules: readonly Rule[];
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly conflict: boolean;
  readonly error: string | null;
  change(rules: readonly Rule[]): void;
  save(): Promise<void>;
  discard(): Promise<void>;
}

export function useRulesEditor<Rule>(
  name: DocumentName,
  load: RulesLoad & { readonly loaded: LoadedDocument },
  codec: {
    readonly parse: (text: string | null) => readonly Rule[];
    readonly serialize: (rules: readonly Rule[]) => string;
  },
): RulesEditor<Rule> {
  const queryClient = useQueryClient();
  const base = load.loaded.text ?? '';
  const saved = codec.parse(load.loaded.text);
  const [draft, setDraft] = useDraft(`rules:${name}`, base);
  const [rules, setRules] = useState<readonly Rule[]>(() => {
    if (draft === '') return saved;
    try {
      return codec.parse(draft);
    } catch {
      return saved;
    }
  });
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const serialized = codec.serialize(rules);
  const dirty = serialized !== codec.serialize(saved);

  const change = (next: readonly Rule[]): void => {
    setRules(next);
    setConflict(false);
    const text = codec.serialize(next);
    setDraft(text === codec.serialize(saved) ? '' : text);
  };

  const save = async (): Promise<void> => {
    if (load.page === null) return;
    setSaving(true);
    setError(null);
    try {
      await saveDocument(load.page, name, serialized, load.loaded.version);
      setDraft('');
      await queryClient.invalidateQueries({ queryKey: [...load.page.base, 'rules', name] });
    } catch (cause) {
      if (isVersionConflict(cause)) setConflict(true);
      else setError(cause instanceof Error ? cause.message : 'The rules could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const discard = async (): Promise<void> => {
    setDraft('');
    setConflict(false);
    setError(null);
    await load.reload();
    setRules(saved);
  };

  return { rules, dirty, saving, conflict, error, change, save, discard };
}
