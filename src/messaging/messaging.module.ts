import { Module } from '@nestjs/common';
import { OutboxRepository } from './repositories/outbox.repository';

/**
 * What the application needs from the messaging layer, which since #22 is one table.
 *
 * **The API process does not know a broker exists.** It was the last thing #19 left
 * behind: checkout held a publisher, published after its COMMIT, and logged when it
 * could not. Now the announcement is an `outbox` row written by the same transaction as
 * the order, and carrying it to the broker is somebody else's job — `npm run start:relay`,
 * its own process, which is also the only process that holds a connection.
 *
 * That removes a whole class of question from this module. There is no "what if the
 * broker is down while an order is being placed": an order being placed is a single
 * transaction against a single database, and it either commits with its event or does not
 * commit at all.
 */
@Module({
    providers: [OutboxRepository],
    exports: [OutboxRepository],
})
export class MessagingModule {}
