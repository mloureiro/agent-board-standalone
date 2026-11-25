import { sql } from 'drizzle-orm';
import { text } from 'drizzle-orm/pg-core';

import { appUser } from './user.js';

export const owner = () =>
  text('owner')
    .notNull()
    .references(() => appUser.username, { onDelete: 'cascade' })
    .default(sql`current_setting('app.owner', true)`);
