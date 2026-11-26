import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DATA_SOURCE } from './constants/database.constants';
import { createDataSource } from './services/data-source.factory';
import { DatabaseService } from './services/database.service';

@Global()
@Module({
    providers: [
        {
            provide: DATA_SOURCE,
            inject: [ConfigService],
            useFactory: createDataSource,
        },
        DatabaseService,
    ],
    exports: [DATA_SOURCE, DatabaseService],
})
export class DatabaseModule {}
