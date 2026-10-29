import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { UsersModule } from '../users/users.module';
import { AuthController } from './controllers/auth.controller';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { RefreshTokensRepository } from './repositories/refresh-tokens.repository';
import { AccessDenylist } from './services/access-denylist.service';
import { AuthService } from './services/auth.service';
import { Authenticator } from './services/authenticator.service';
import { PasswordService } from './services/password.service';
import { TokenSigner } from './services/token-signer.service';

/**
 * Two global guards, and their order is the design.
 *
 * `JwtAuthGuard` first, `RolesGuard` second. Nest runs `APP_GUARD` providers in the order
 * they are registered, and the second one reads what the first one wrote: a role check
 * needs a caller, and a caller is what authentication produces. Registered the other way
 * round, `RolesGuard` would find no principal on every request and either refuse
 * everything or — worse, if it were written to shrug — let a decorated route through
 * unauthenticated.
 *
 * Both are global rather than per-controller, so the **default is closed**. A new route
 * is protected by existing, and `@Public()` is the deliberate opt-out; the opposite
 * arrangement fails open and the failure is invisible until somebody reads a log.
 *
 * The rate-limit guard from #23 stays where it is, registered ahead of these in
 * app.module.ts: refusing a flood should not cost a token verification, let alone the
 * database read one implies.
 */
/*
 * `@Global` on purpose. The rate limiter and the session middleware both need to read a
 * token's subject, and an `imports: [AuthModule]` in either of them would add an edge to
 * the module graph that Nest walks when it collects `APP_GUARD` providers — which is the
 * graph that decides the order those guards run in. Declaring the module global gives
 * them the providers without touching that order.
 */
@Global()
@Module({
    imports: [UsersModule],
    controllers: [AuthController],
    providers: [
        TokenSigner,
        PasswordService,
        AccessDenylist,
        RefreshTokensRepository,
        Authenticator,
        AuthService,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
    ],
    exports: [Authenticator, TokenSigner, AuthService, RefreshTokensRepository],
})
export class AuthModule {}
