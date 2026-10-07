import { appConfig } from './config.js';
import { createAuth } from './auth.js';
import { appDatabase } from './app-db.js';

export const auth = createAuth(appDatabase(appConfig().databaseUrl));
