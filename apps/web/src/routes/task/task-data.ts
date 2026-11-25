import {
  answerClientTaskRoute,
  applyPolishClientTaskRoute,
  catalogsClientMachinesRoute,
  configureClientTaskRoute,
  dismissQuestionClientTaskRoute,
  doneClientTaskRoute,
  editClientTaskRoute,
  forkClientTaskRoute,
  getClientLinksRoute,
  getClientTaskRoute,
  listClientDirectoriesRoute,
  moveClientTaskRoute,
  removePrClientTaskRoute,
  replyClientTaskRoute,
  rerunClientTaskRoute,
  sendClientTaskRoute,
  setClosedClientTaskRoute,
  setNotBeforeClientTaskRoute,
  setPriorityClientTaskRoute,
  setProjectClientTaskRoute,
  stopClientTaskRoute,
  stopWatchClientTaskRoute,
  takeBackClientTaskRoute,
  wakeNowClientTaskRoute,
  type Effort,
  type Priority,
} from '@agent-board/contract';
import { bindings, seal, type Keys } from '@agent-board/sealing';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef } from 'react';

import { callRoute } from '../../auth/api.js';
import { parseLinkRules, type LinkRule } from '../../components/index.js';
import { useKeys } from '../../keys/index.js';
import { ApiError } from '../../session/index.js';
import { useServers } from '../../servers/index.js';
import type { ServerClient } from '../../transport/client.js';
import {
  POLL_MS,
  boardKey,
  featuresOf,
  fetchProjectNames,
  useEventStream,
} from '../board/board-data.js';
import { attempt, sealPromptAsUser } from '../board/card-model.js';
import { skillsOf, type Skill } from './catalog-model.js';
import { newTaskId, sealAnswers, sealNote } from './compose.js';
import type { Answer, Question } from './question-model.js';
import { formatAnswers } from './question-model.js';
import { decryptTask, type TaskView } from './task-model.js';

export interface DirectoryOption {
  readonly id: string;
  readonly path: string;
}

export interface ProjectOption {
  readonly id: string;
  readonly name: string;
}

export interface TaskData {
  readonly serverId: string;
  readonly keys: Keys;
  readonly features: readonly string[];
  readonly view: TaskView | undefined;
  readonly notFound: boolean;
  readonly failure: string | null;
  readonly projects: readonly ProjectOption[];
  readonly directories: readonly DirectoryOption[];
  readonly skills: readonly Skill[];
  readonly linkRules: readonly LinkRule[];
}

export interface TaskActions {
  rename(title: string): Promise<unknown>;
  setPriority(priority: Priority): Promise<unknown>;
  configure(change: {
    model?: string | null;
    effort?: Effort | null;
    lane?: string | null;
    autoDone?: boolean;
    place?: { machine: string; directoryId: string } | null;
  }): Promise<unknown>;
  setProject(projectId: string): Promise<unknown>;
  removePr(prId: string): Promise<unknown>;
  stopWatch(watchId: string): Promise<unknown>;
  reply(text: string, resume: boolean): Promise<boolean>;
  send(text: string): Promise<boolean>;
  stop(text?: string): Promise<boolean>;
  takeBack(): Promise<boolean>;
  done(): Promise<boolean>;
  rerun(): Promise<boolean>;
  setClosed(closed: boolean): Promise<boolean>;
  move(status: 'backlog' | 'todo', startText?: string): Promise<boolean>;
  wakeNow(): Promise<boolean>;
  runNow(): Promise<boolean>;
  answer(
    noteId: string,
    questions: readonly Question[],
    answers: readonly Answer[],
    note: string,
  ): Promise<boolean>;
  dismiss(noteId: string): Promise<boolean>;
  fork(input: { title: string; text: string }): Promise<boolean>;
  editPrompt(input: { title: string; text: string }): Promise<boolean>;
  applyPolish(input: { polishId: string; title: string; text: string }): Promise<boolean>;
}

const NO_SKILLS: readonly Skill[] = [];
const NO_RULES: readonly LinkRule[] = [];

const previousText = (title: string, prompt: string): string =>
  `Previous title: ${title}\n\nPrevious prompt:\n\n${prompt}`;

export const taskKey = (serverId: string, keyId: string, id: string) =>
  [...boardKey(serverId, keyId), 'task', id] as const;

export function useTaskData(id: string): TaskData | null {
  const { active, clientOf, connectionOf } = useServers();
  const { state } = useKeys();
  const queryClient = useQueryClient();
  const serverId = active?.id ?? null;
  const keys = state.status === 'unlocked' ? state.keys : null;
  const clientRef = useRef<ServerClient | null>(null);
  clientRef.current = serverId === null ? null : clientOf(serverId);
  const hasClient = clientRef.current !== null;
  const scope = serverId ?? '';
  const keyId = keys?.keyId ?? '';
  const features = serverId === null ? [] : featuresOf(connectionOf(serverId));
  const enabled = keys !== null && hasClient;

  const stream = useEventStream(
    scope,
    keys === null || !hasClient ? null : clientRef.current,
    () => void queryClient.invalidateQueries({ queryKey: boardKey(scope, keyId) }),
  );

  const detail = useQuery({
    queryKey: taskKey(scope, keyId, id),
    enabled,
    refetchInterval: stream === 'open' ? false : POLL_MS,
    retry: (count, error) =>
      !(error instanceof ApiError && error.code === 'not-found') && count < 2,
    queryFn: async (): Promise<TaskView> => {
      const client = clientRef.current;
      if (client === null || keys === null) throw new Error('The server is not available.');
      return decryptTask(keys, await callRoute(client, getClientTaskRoute, { id }));
    },
  });

  const projects = useQuery({
    queryKey: [...boardKey(scope, keyId), 'projects'],
    enabled: enabled && features.includes('projects'),
    queryFn: async () => {
      const client = clientRef.current;
      if (client === null || keys === null) return new Map<string, string>();
      return fetchProjectNames(client, keys);
    },
  });

  const directories = useQuery({
    queryKey: [...boardKey(scope, keyId), 'directories'],
    enabled: enabled && features.includes('directories'),
    queryFn: async (): Promise<DirectoryOption[]> => {
      const client = clientRef.current;
      if (client === null || keys === null) return [];
      const answer = await callRoute(client, listClientDirectoriesRoute, {});
      const options: DirectoryOption[] = [];
      for (const directory of answer.directories) {
        const path = await attempt(keys, bindings.directoryPath(directory.id), directory.path);
        options.push({ id: directory.id, path: path ?? 'Unreadable directory' });
      }
      return options;
    },
  });

  const machine = detail.data?.task.machine ?? null;
  const catalogs = useQuery({
    queryKey: [...boardKey(scope, keyId), 'catalogs'],
    enabled: enabled && machine !== null,
    queryFn: async () => {
      const client = clientRef.current;
      if (client === null || keys === null) return new Map<string, string>();
      const answer = await callRoute(client, catalogsClientMachinesRoute, {});
      const opened = new Map<string, string>();
      for (const entry of answer.catalogs) {
        const text = await attempt(
          keys,
          bindings.machineDocument('machine.catalog', entry.name),
          entry.catalog,
        );
        if (text !== null) opened.set(entry.name, text);
      }
      return opened;
    },
  });

  const links = useQuery({
    queryKey: [...boardKey(scope, keyId), 'links'],
    enabled: enabled && features.includes('link-rules'),
    queryFn: async (): Promise<readonly LinkRule[]> => {
      const client = clientRef.current;
      if (client === null || keys === null) return [];
      const { document } = await callRoute(client, getClientLinksRoute, {});
      if (document === null) return [];
      const text = await attempt(keys, bindings.links(document.version), document.document);
      return text === null ? [] : parseLinkRules(text);
    },
  });

  const projectOptions = useMemo(
    () =>
      [...(projects.data ?? new Map<string, string>())].map(([pid, name]) => ({ id: pid, name })),
    [projects.data],
  );

  const directoryPath = (() => {
    const task = detail.data?.task;
    if (task === undefined) return null;
    const known = directories.data?.find((directory) => directory.id === task.directoryId)?.path;
    return known ?? detail.data?.legacyDirectory ?? null;
  })();
  const catalogText = machine === null ? undefined : catalogs.data?.get(machine);
  const skills = useMemo(
    () => (catalogText === undefined ? NO_SKILLS : skillsOf(catalogText, directoryPath)),
    [catalogText, directoryPath],
  );

  if (serverId === null || keys === null) return null;
  const missing = detail.error instanceof ApiError && detail.error.code === 'not-found';
  return {
    serverId,
    keys,
    features,
    view: detail.data,
    notFound: missing,
    failure: detail.isError && !missing ? detail.error.message : null,
    projects: projectOptions,
    directories: directories.data ?? [],
    skills,
    linkRules: links.data ?? NO_RULES,
  };
}

export function useTaskActions(data: TaskData, id: string): TaskActions {
  const { clientOf } = useServers();
  const queryClient = useQueryClient();
  const clientFor = (): ServerClient => {
    const client = clientOf(data.serverId);
    if (client === null) throw new Error('The server is not available.');
    return client;
  };
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: taskKey(data.serverId, data.keys.keyId, id) });
  const run = useMutation({
    mutationFn: (call: (client: ServerClient) => Promise<unknown>) => call(clientFor()),
    onSettled: refresh,
  });
  const send = (call: (client: ServerClient) => Promise<unknown>) =>
    run.mutateAsync(call).catch(() => undefined);
  const act = (call: (client: ServerClient) => Promise<unknown>): Promise<boolean> =>
    run.mutateAsync(call).then(
      () => true,
      () => false,
    );
  const { keys, view } = data;
  const taskOf = () => {
    if (view === undefined) throw new Error('The task is not loaded.');
    return view;
  };

  return {
    rename: async (title) =>
      send(async (client) =>
        callRoute(client, configureClientTaskRoute, {
          id,
          title: await seal(data.keys, bindings.title({ task: id }), title),
        }),
      ),
    setPriority: (priority) =>
      send((client) => callRoute(client, setPriorityClientTaskRoute, { id, priority })),
    configure: (change) =>
      send((client) => callRoute(client, configureClientTaskRoute, { id, ...change })),
    setProject: (projectId) =>
      send((client) =>
        callRoute(client, setProjectClientTaskRoute, { id, projectId, directoryId: null }),
      ),
    removePr: (prId) => send((client) => callRoute(client, removePrClientTaskRoute, { id, prId })),
    stopWatch: (watchId) =>
      send((client) => callRoute(client, stopWatchClientTaskRoute, { id, watchId })),
    reply: (text, resume) =>
      act(async (client) =>
        callRoute(client, replyClientTaskRoute, {
          id,
          message: await sealNote(keys, id, 'comment', text),
          resume,
        }),
      ),
    send: (text) =>
      act(async (client) =>
        callRoute(client, sendClientTaskRoute, {
          id,
          message: await sealNote(keys, id, 'comment', text),
        }),
      ),
    stop: (text) =>
      act(async (client) =>
        callRoute(client, stopClientTaskRoute, {
          id,
          ...(text === undefined ? {} : { message: await sealNote(keys, id, 'comment', text) }),
        }),
      ),
    takeBack: () => act((client) => callRoute(client, takeBackClientTaskRoute, { id })),
    done: () => act((client) => callRoute(client, doneClientTaskRoute, { id })),
    rerun: () => act((client) => callRoute(client, rerunClientTaskRoute, { id })),
    setClosed: (closed) =>
      act((client) => callRoute(client, setClosedClientTaskRoute, { id, closed })),
    move: (status, startText) =>
      act(async (client) => {
        const shape = taskOf().promptShape;
        const startInput =
          startText === undefined || shape === null
            ? undefined
            : await sealPromptAsUser(keys, id, shape, startText);
        return callRoute(client, moveClientTaskRoute, {
          id,
          status,
          ...(startInput === undefined ? {} : { startInput }),
        });
      }),
    wakeNow: () => act((client) => callRoute(client, wakeNowClientTaskRoute, { id })),
    runNow: () =>
      act((client) => callRoute(client, setNotBeforeClientTaskRoute, { id, notBefore: null })),
    answer: (noteId, questions, answers, note) =>
      act(async (client) => {
        const message =
          formatAnswers(questions, answers) + (note.trim() === '' ? '' : `\n\n${note.trim()}`);
        return callRoute(client, answerClientTaskRoute, {
          id,
          questionNoteId: noteId,
          answers: await sealAnswers(keys, id, JSON.stringify(answers)),
          message: await sealNote(keys, id, 'answer', message),
        });
      }),
    dismiss: (noteId) =>
      act((client) =>
        callRoute(client, dismissQuestionClientTaskRoute, { id, questionNoteId: noteId }),
      ),
    fork: ({ title, text }) =>
      act(async (client) => {
        const parent = taskOf();
        const shape = parent.promptShape;
        if (shape === null) throw new Error('The prompt of this task cannot be read.');
        const forkId = newTaskId();
        const forkShape = { forkOf: id, agent: shape.agent, directoryId: parent.task.directoryId };
        return callRoute(client, forkClientTaskRoute, {
          id: forkId,
          parentId: id,
          title: await seal(keys, bindings.title({ task: forkId }), title),
          input: await sealPromptAsUser(keys, forkId, forkShape, text),
          directoryId: parent.task.directoryId,
          ...(shape.agent === null
            ? {}
            : { agent: await seal(keys, bindings.agent({ task: forkId }), shape.agent) }),
        });
      }),
    editPrompt: ({ title, text }) =>
      act(async (client) => {
        const current = taskOf();
        const shape = current.promptShape;
        if (shape === null || current.prompt === null) {
          throw new Error('The prompt of this task cannot be read.');
        }
        return callRoute(client, editClientTaskRoute, {
          id,
          title: await seal(keys, bindings.title({ task: id }), title),
          input: await sealPromptAsUser(
            keys,
            id,
            { ...shape, directoryId: current.task.directoryId },
            text,
          ),
          previous: await sealNote(
            keys,
            id,
            'comment',
            previousText(current.title, current.prompt),
          ),
        });
      }),
    applyPolish: ({ polishId, title, text }) =>
      act(async (client) => {
        const current = taskOf();
        const parent = current.parentTask;
        const old = current.parentPrompt;
        if (parent === null || old === null) throw new Error('The parent task cannot be read.');
        const oldTitle = await attempt(keys, bindings.title({ task: parent.id }), parent.title);
        return callRoute(client, applyPolishClientTaskRoute, {
          id: parent.id,
          polishId,
          title: await seal(keys, bindings.title({ task: parent.id }), title),
          input: await sealPromptAsUser(
            keys,
            parent.id,
            { ...old.shape, directoryId: parent.directoryId },
            text,
          ),
          previous: await sealNote(
            keys,
            parent.id,
            'comment',
            previousText(oldTitle ?? '', old.text),
          ),
        });
      }),
  };
}
