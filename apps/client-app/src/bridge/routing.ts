const TITLE_SUFFIX = ' · Agent Board';
const HOME_LABEL = /-0$/;
const WATCHED_MUTATIONS = { childList: true, characterData: true, subtree: true } as const;

export type Report = (command: string, args: Record<string, unknown>) => Promise<unknown>;

export interface RoutingOptions {
  readonly target: Window;
  readonly label: string;
  readonly report: Report;
}

export function stripSuffix(title: string): string {
  return title.endsWith(TITLE_SUFFIX) ? title.slice(0, -TITLE_SUFFIX.length) : title;
}

function send(report: Report, command: string, args: Record<string, unknown>): void {
  report(command, args).catch(() => undefined);
}

function watchHistory({ target, label, report }: RoutingOptions): () => void {
  const { history, location } = target;
  const intent = HOME_LABEL.test(label) ? 'open' : 'route';
  let last = location.pathname + location.search;
  const announce = (): void => {
    const path = location.pathname + location.search;
    if (path === last) return;
    last = path;
    send(report, 'tab_navigate', { path, intent });
  };
  const { pushState, replaceState } = history;
  history.pushState = function (...args: Parameters<History['pushState']>) {
    pushState.apply(this, args);
    announce();
  };
  history.replaceState = function (...args: Parameters<History['replaceState']>) {
    replaceState.apply(this, args);
    announce();
  };
  target.addEventListener('popstate', announce);
  return () => {
    history.pushState = pushState;
    history.replaceState = replaceState;
    target.removeEventListener('popstate', announce);
  };
}

function watchTitle({ target, report }: RoutingOptions): () => void {
  const doc = target.document;
  let last = '';
  let observer: MutationObserver | undefined;
  const announce = (): void => {
    const title = stripSuffix(doc.title);
    if (title === last) return;
    last = title;
    send(report, 'tab_title', { title });
  };
  const start = (): void => {
    const element = doc.querySelector('title');
    observer?.disconnect();
    const watching = new MutationObserver(() => {
      if (!element && doc.querySelector('title')) start();
      announce();
    });
    observer = watching;
    watching.observe(element ?? doc.documentElement, WATCHED_MUTATIONS);
    announce();
  };
  if (doc.documentElement) start();
  else doc.addEventListener('DOMContentLoaded', start, { once: true });
  return () => {
    observer?.disconnect();
    doc.removeEventListener('DOMContentLoaded', start);
  };
}

function watchCycleKey({ target, report }: RoutingOptions): () => void {
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab' || !event.ctrlKey || event.metaKey || event.altKey || event.repeat) {
      return;
    }
    event.preventDefault();
    send(report, 'tab_cycle', { dir: event.shiftKey ? 'previous' : 'next' });
  };
  target.addEventListener('keydown', onKey, true);
  return () => target.removeEventListener('keydown', onKey, true);
}

function watchFocus({ target, report }: RoutingOptions): () => void {
  const onFocus = (): void => send(report, 'tab_focused', {});
  target.addEventListener('focus', onFocus);
  return () => target.removeEventListener('focus', onFocus);
}

export function installRouting(options: RoutingOptions): () => void {
  const stops = [
    watchHistory(options),
    watchTitle(options),
    watchCycleKey(options),
    watchFocus(options),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}
