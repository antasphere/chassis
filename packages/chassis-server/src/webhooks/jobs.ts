import type { JobDeclaration } from '../jobs/pgboss.js';
import type { Logger } from '../logger.js';
import {
  WEBHOOK_DELIVERIES_HELD_QUEUE,
  WEBHOOK_DELIVERIES_QUEUE,
  WEBHOOK_EVENTS_QUEUE,
  WEBHOOK_PURGE_QUEUE,
  WebhookDeliveryFailed,
  type WebhookDeliveryJob,
  type WebhookEventJob,
  type WebhookService
} from './service.js';

/**
 * The four queues of the webhooks, declared to the job runtime like a tool's
 * own (`createJobs` installs them in the same lock section, in this order):
 * the held queue FIRST so the delivery queue can name it as its dead letter
 * (pg-boss's job row holds a foreign key on it), then the fan-out, the
 * delivery with its retry budget, and the nightly purge.
 */
export function webhookJobs(
  service: WebhookService,
  logger: Logger,
  retentionDays: number
): JobDeclaration[] {
  const { dials } = service;
  return [
    {
      queue: WEBHOOK_DELIVERIES_HELD_QUEUE,
      options: { retryLimit: 10, retryDelaySeconds: 60, retryBackoff: true },
      handler: async (data) => {
        const job = data as WebhookDeliveryJob | null;
        if (!job?.deliveryId) return;
        await service.hold(job.deliveryId);
      }
    },
    {
      queue: WEBHOOK_EVENTS_QUEUE,
      handler: async (data) => {
        const job = data as WebhookEventJob | null;
        if (!job?.id) return;
        const count = await service.fanOut(job);
        logger.debug({ eventId: job.id, type: job.type, deliveries: count }, 'webhooks: event fanned out');
      }
    },
    {
      queue: WEBHOOK_DELIVERIES_QUEUE,
      options: {
        retryLimit: dials.retryLimit,
        retryDelaySeconds: dials.retryDelaySeconds,
        retryBackoff: true,
        deadLetter: WEBHOOK_DELIVERIES_HELD_QUEUE
      },
      handler: async (data) => {
        const job = data as WebhookDeliveryJob | null;
        if (!job?.deliveryId) return;
        try {
          await service.attempt(job.deliveryId, { retryable: true });
        } catch (e) {
          if (e instanceof WebhookDeliveryFailed) {
            logger.warn(
              { deliveryId: e.deliveryId, reason: e.message },
              'webhooks: a delivery attempt failed, will retry'
            );
          }
          throw e;
        }
      }
    },
    {
      queue: WEBHOOK_PURGE_QUEUE,
      schedule: { cron: '0 3 * * *', enabled: retentionDays > 0 },
      handler: async () => {
        const deleted = await service.purge(retentionDays);
        logger.info({ retentionDays, deleted }, 'webhook deliveries retention purge ran');
      }
    }
  ];
}
