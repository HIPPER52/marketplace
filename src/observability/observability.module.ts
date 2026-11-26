import { Module } from '@nestjs/common';
import { MetricsController } from './controllers/metrics.controller';

/**
 * The module exists for one route. Everything else in this folder is wired where it has
 * to be rather than where a module could reach it: the logger is a module-level instance
 * because Nest's own logger is set before `NestFactory.create` has a container to inject
 * from, the two middlewares are plain Express and are registered ahead of the validator,
 * and tracing starts before this file is loaded at all.
 */
@Module({ controllers: [MetricsController] })
export class ObservabilityModule {}
