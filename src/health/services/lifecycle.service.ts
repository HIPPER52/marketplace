import { Injectable, Logger } from '@nestjs/common';
import { ServingState } from '../constants/lifecycle.constant';

/**
 * Whether this process wants new traffic.
 *
 * It exists because "the pod is going away" and "the socket is closed" are two different
 * moments, and a rolling update that treats them as one drops requests. The sequence a
 * zero-failure rollout needs is: SIGTERM arrives, **readiness turns red first**, the
 * EndpointSlice controller takes this pod's IP out of the Service, whatever was already
 * in flight finishes, and only then does the socket close. Closing it on SIGTERM instead
 * refuses connections a load balancer is still sending, which is the second of the two
 * holes in a default rolling update.
 *
 * A field on a provider rather than a module-level `let`, because the readiness
 * controller has to read the same value `main.ts` writes, and a shared mutable module is
 * the version of that which breaks the day a test imports it twice.
 */
@Injectable()
export class Lifecycle {
    private readonly logger = new Logger(Lifecycle.name);
    private current: ServingState = ServingState.Serving;

    get state(): ServingState {
        return this.current;
    }

    get isDraining(): boolean {
        return this.current === ServingState.Draining;
    }

    /**
     * Irreversible on purpose: a process that announced it is going away does not come
     * back and start claiming to be ready again.
     */
    beginDraining(): void {
        if (this.current === ServingState.Draining) {
            return;
        }

        this.current = ServingState.Draining;
        this.logger.log('readiness is red: no new traffic, finishing what is in flight');
    }
}
