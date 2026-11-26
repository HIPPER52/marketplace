import { Module } from '@nestjs/common';
import { UsersRepository } from './repositories/users.repository';

@Module({
    providers: [UsersRepository],
    exports: [UsersRepository],
})
export class UsersModule {}
