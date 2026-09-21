import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PG_POOL } from './constants/database.constants';
import { createPool, DatabaseService } from './services/database.service';

@Global()
@Module({
    providers: [
        {
            provide: PG_POOL,
            inject: [ConfigService],
            useFactory: createPool,
        },
        DatabaseService,
    ],
    exports: [DatabaseService],
})
export class DatabaseModule {}
