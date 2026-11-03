import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ProblemError, ProblemType } from '../../common/errors/problem.error';
import type { Role } from '../constants/role.constant';
import { REQUIRED_ROLES } from '../decorators/roles.decorator';
import type { Principal } from '../types/auth.types';

/**
 * Decides **whether**, for the one question a guard is able to answer.
 *
 * A role is a property of the actor, so it can be checked before anything is loaded — "is
 * this a seller?" needs no row. That is exactly the boundary: the moment the question
 * becomes "is this *their* order?", a guard would have to fetch the resource itself, which
 * means fetching it twice and putting domain knowledge in the wrong layer. Ownership is
 * therefore checked where the resource already is; see OrdersController.
 *
 * Failures here are **403**, not 401. The caller is known — the token verified, the
 * account exists — and the answer is still no. A client's SDK must not try to refresh its
 * way out of that, and an application that confuses the two either loops on refresh or
 * logs the user out on every page they are not allowed to see.
 */
@Injectable()
export class RolesGuard implements CanActivate {
    constructor(private readonly reflector: Reflector) {}

    canActivate(context: ExecutionContext): boolean {
        const required = this.reflector.getAllAndOverride<Role[] | undefined>(REQUIRED_ROLES, [
            context.getHandler(),
            context.getClass(),
        ]);

        if (required === undefined || required.length === 0) {
            return true;
        }

        const request = context.switchToHttp().getRequest<Request & { principal?: Principal }>();
        const principal = request.principal;

        // Unauthenticated: JwtAuthGuard either ran and refused, or the route is public and
        // also role-restricted, which is a contradiction worth failing on rather than
        // silently allowing.
        if (principal === undefined) {
            throw new ProblemError({
                status: 401,
                type: ProblemType.unauthenticated,
                title: 'Not authenticated',
                detail: 'This route requires a role, and no caller was established.',
            });
        }

        if (!required.includes(principal.role)) {
            throw new ProblemError({
                status: 403,
                type: ProblemType.forbidden,
                title: 'Forbidden',
                detail: `This action is for ${required.join(' or ')}; you are ${principal.role}.`,
            });
        }

        return true;
    }
}
