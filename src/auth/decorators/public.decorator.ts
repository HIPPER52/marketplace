import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'auth:public';

/**
 * Marks a route as reachable without a token.
 *
 * Opt-out rather than opt-in, and that asymmetry is deliberate: the guard is global, so a
 * route somebody forgets to think about is **closed**. The opposite arrangement — decorate
 * what needs protecting — fails open, and the failure is invisible until somebody notices
 * the endpoint in a log.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);
