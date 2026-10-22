import { Module } from '@nestjs/common';
import { SessionMiddleware } from './middleware/session.middleware';
import { SessionStore } from './services/session-store.service';

@Module({
    providers: [SessionStore, SessionMiddleware],
    exports: [SessionStore, SessionMiddleware],
})
export class SessionsModule {}
