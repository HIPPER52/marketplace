import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../../auth/decorators/public.decorator';
import { METRICS_PATH } from '../constants/observability.constant';
import { metricsRegistry } from '../utils/metrics.util';

/**
 * The scrape target. Operational, outside the contract and outside authentication, for
 * the same reasons `/health` and `/readiness` are: a scraper has nowhere to keep a token
 * and nothing to refresh it with, and the exposition format is not something the OpenAPI
 * document should be made to describe.
 *
 * It is exempt from the rate limit too. A limiter that throttled the scrape would make
 * the panel go blank precisely during the incident the limit was protecting against.
 */
@Public()
@Controller()
export class MetricsController {
    @Get(METRICS_PATH)
    async metrics(@Res() response: Response): Promise<void> {
        response.setHeader('Content-Type', metricsRegistry.contentType);
        response.send(await metricsRegistry.metrics());
    }
}
