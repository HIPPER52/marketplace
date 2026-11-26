import { SetMetadata } from '@nestjs/common';
import type { Role } from '../constants/role.constant';

export const REQUIRED_ROLES = 'auth:roles';

/**
 * What kind of actor this route is for.
 *
 * A role answers "what sort of person is this", and that is all it can answer. Whether
 * *this* person may touch *that* row is a different question with a different answer, and
 * it is not asked here — a guard runs before the resource is loaded and has nothing to
 * compare against. See OrdersController for where that line is.
 */
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator =>
    SetMetadata(REQUIRED_ROLES, roles);
