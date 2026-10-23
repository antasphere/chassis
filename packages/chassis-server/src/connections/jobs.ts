import type { JobDeclaration } from '../jobs/pgboss.js';
import type { Logger } from '../logger.js';
import { CONNECTION_DELIVERIES_PURGE_QUEUE, type AnyConnectionService } from './service.js';

/** The nightly purge of the connection deliveries log, on the webhook deliveries' retention. */
export function connectionJobs(
  service: AnyConnectionService,
  logger: Logger,
  retentionDays: number
): JobDeclaration[] {
  return [
    {
      queue: CONNECTION_DELIVERIES_PURGE_QUEUE,
      schedule: { cron: '10 3 * * *', enabled: retentionDays > 0 },
      handler: async () => {
        const deleted = await service.purge(retentionDays);
        logger.info({ retentionDays, deleted }, 'connection deliveries retention purge ran');
      }
    }
  ];
}
