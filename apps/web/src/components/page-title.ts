import { useEffect } from 'react';

export const APP_TITLE = 'Agent Board';

export const pageTitle = (title: string | null | undefined): string =>
  title ? `${title} · ${APP_TITLE}` : APP_TITLE;

export const usePageTitle = (title: string | null | undefined): void => {
  useEffect(() => {
    document.title = pageTitle(title);
  }, [title]);
};
