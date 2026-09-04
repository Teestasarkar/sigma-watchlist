/** Drop every table and re-migrate. Destructive, by design. */
import { buildApp } from '../app.js';
import { dropAll, migrate } from '../db/migrate.js';
import { createLogger } from '../infra/logger.js';

const log = createLogger('reset');

const app = await buildApp();
await dropAll(app.sql);
await migrate(app.sql);
await app.bootstrap();
log.info('database reset and reseeded');
await app.shutdown();
process.exit(0);
