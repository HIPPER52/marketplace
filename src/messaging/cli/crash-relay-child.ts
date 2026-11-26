import 'reflect-metadata';
import { OutboxRelay } from '../services/outbox-relay.service';
import { openStand } from '../utils/demo-stand.util';

/**
 * A relay that dies between the publish and the mark.
 *
 * Forked by `demo:crash-relay`; never run directly. It claims the outbox row, hands it to
 * the broker, tells the parent it did — and is killed with SIGKILL before `published_at`
 * is written.
 *
 * SIGKILL to its own pid, in a process of its own, because the shape is the subject. A
 * thrown exception would also roll the transaction back and the demo would pass, but a
 * service does not politely raise an error at three in the morning; it disappears, the
 * operating system closes its sockets, and Postgres discovers an abandoned transaction
 * rather than receiving a ROLLBACK. The row that comes back is the same row either way —
 * what differs is whether the run proved it against the real failure.
 *
 * It does not purge anything on the way in: the row it is here to publish is already in
 * the outbox, written by the parent's checkout.
 */

export interface CrashReport {
    published: number;
    recordId: string;
}

async function main(): Promise<void> {
    const stand = await openStand({ purge: false });

    const relay = new OutboxRelay(stand.dataSource, stand.publisher, {
        onPublished: async (record) => {
            await report({ published: 1, recordId: record.id });

            // The broker has the message. `published_at` is still NULL and the claiming
            // transaction is still open — from Postgres's side this is a client that
            // vanished mid-transaction, so the row is rolled back to unpublished and the
            // lock dies with the connection.
            process.kill(process.pid, 'SIGKILL');

            // Unreachable in practice; here so nothing downstream can run if it ever is.
            await new Promise<never>(() => {});
        },
    });

    await relay.drainOnce();

    console.error('crash-relay-child: nothing was published; there was no row to take');
    process.exit(1);
}

/** Resolves once the message has actually left this process — SIGKILL flushes nothing. */
function report(payload: CrashReport): Promise<void> {
    return new Promise((resolve, reject) => {
        if (process.send === undefined) {
            resolve();
            return;
        }

        process.send(payload, (error: Error | null) => {
            if (error === null) {
                resolve();
            } else {
                reject(error);
            }
        });
    });
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
