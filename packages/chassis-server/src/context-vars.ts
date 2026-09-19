import type { Principal } from '@antasphere/chassis-contract';
import type { Logger } from './logger.js';

/**
 * The Hono context variables the chassis modules READ (`audit/service.ts`,
 * `observability/otel.ts`). The middleware that SET them (request-id,
 * auth-context) declare the same three with the same types; an interface
 * merges identical declarations, so both can stand until those middleware
 * move here. Types only: nothing imports this file and it emits no code.
 */
declare module 'hono' {
  interface ContextVariableMap {
    requestId: string;
    logger: Logger;
    principal: Principal | null;
  }
}
