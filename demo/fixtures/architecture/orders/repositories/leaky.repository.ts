import { Router } from 'express';

/**
 * The broken input for the architecture gate.
 *
 * A repository that imports the HTTP framework. The path matters as much as the import:
 * `.dependency-cruiser.cjs` decides what a module is from the folder it lives in — the
 * same folder-per-kind convention `src/` follows — so this file is a repository for
 * the same reason `src/orders/repositories/orders.repository.ts` is one, and the rule
 * `domain-not-to-http` is evaluated against it unchanged.
 *
 * That is the point of keeping the fixture outside `src/` but shaped like it: the gate is
 * run twice with one configuration and two inputs, rather than twice with two
 * configurations, which would demonstrate nothing but that a rule can be written to fail.
 */
export function leak(): Router {
    return Router();
}
