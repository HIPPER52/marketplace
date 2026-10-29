import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ProblemError, ProblemType } from '../../common/errors/problem.error';
import type {
    Identity,
    LoginRequest,
    LogoutRequest,
    RefreshRequest,
    TokenPairResponse,
} from '../../common/types/api.types';
import { UsersRepository } from '../../users/repositories/users.repository';
import { BEARER_SCHEME } from '../constants/auth.constant';
import { CurrentUser } from '../decorators/principal.decorator';
import { Public } from '../decorators/public.decorator';
import { AuthService } from '../services/auth.service';
import type { Principal, TokenPair } from '../types/auth.types';

/**
 * The four routes that hand out identity, rotate it, and take it back.
 *
 * `login` and `refresh` are `@Public()` — they are how a caller gets a token, so
 * requiring one would be a loop. `logout` is not: it revokes *this* session, and which
 * session that is comes from the access token rather than from the body.
 */
@Controller('auth')
export class AuthController {
    constructor(
        private readonly auth: AuthService,
        private readonly users: UsersRepository,
    ) {}

    @Public()
    @Post('login')
    @HttpCode(200)
    async login(@Body() body: LoginRequest): Promise<TokenPairResponse> {
        return pair(await this.auth.login(body.email, body.password));
    }

    @Public()
    @Post('refresh')
    @HttpCode(200)
    async refresh(@Body() body: RefreshRequest): Promise<TokenPairResponse> {
        return pair(await this.auth.refresh(body.refresh_token));
    }

    /**
     * Ends the session named by the body, for the caller named by the token.
     *
     * The refresh token is in the body rather than inferred, so signing out of this
     * device does not sign the person out of their others — "log out everywhere" is a
     * different operation and this contract does not claim to offer it.
     */
    @Post('logout')
    @HttpCode(204)
    async logout(@CurrentUser() principal: Principal, @Body() body: LogoutRequest): Promise<void> {
        await this.auth.logout(principal, body.refresh_token);
    }

    @Get('me')
    async me(@CurrentUser() principal: Principal): Promise<Identity> {
        const account = await this.users.byId(principal.userId);

        if (account === null) {
            // The guard read this row a moment ago, so getting here means the account was
            // deleted between the two reads. 401 rather than 404: the subject of the
            // request is the caller, and the caller no longer exists.
            throw new ProblemError({
                status: 401,
                type: ProblemType.unauthenticated,
                title: 'Not authenticated',
                detail: 'The account this token belongs to no longer exists.',
            });
        }

        return {
            id: account.id,
            email: account.email,
            display_name: account.displayName,
            role: account.role,
        };
    }
}

function pair(tokens: TokenPair): TokenPairResponse {
    return {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_type: BEARER_SCHEME,
        expires_in: tokens.expiresIn,
    };
}
