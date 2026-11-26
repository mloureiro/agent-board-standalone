import type { ReactNode } from 'react';
import { Navigate, useParams } from 'react-router';

export function TaskLink(): ReactNode {
  const { id = '' } = useParams();
  return <Navigate to={`/tasks/${encodeURIComponent(id)}`} replace />;
}
