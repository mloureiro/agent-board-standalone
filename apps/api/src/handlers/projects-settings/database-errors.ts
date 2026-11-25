const FOREIGN_KEY_VIOLATION = '23503';

export const isForeignKeyViolation = (error: unknown): boolean => {
  for (let current = error; current instanceof Error; current = current.cause)
    if ((current as { code?: unknown }).code === FOREIGN_KEY_VIOLATION) return true;
  return false;
};
