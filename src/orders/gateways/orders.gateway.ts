import type { OnModuleDestroy } from '@nestjs/common';
import {
    ConnectedSocket,
    MessageBody,
    type OnGatewayInit,
    SubscribeMessage,
    WebSocketGateway,
    WebSocketServer,
} from '@nestjs/websockets';
import type { Subscription } from 'rxjs';
import type { Server, Socket } from 'socket.io';
import { JOIN_EVENT, ORDER_STATUS_EVENT, roomOf } from '../constants/realtime.constant';
import { OrdersRepository } from '../repositories/orders.repository';
import { OrderEventsService } from '../services/order-events.service';
import { toPayload } from '../types/order-event.types';

/**
 * Status changes, pushed to the people entitled to see them.
 *
 * ## Why a room and not a broadcast
 *
 * `server.emit` would reach every connected socket, which means every customer would
 * learn when any other customer's order ships. A room is a server-side label on a socket:
 * the socket is put in `orders:<id>` only after this gateway has confirmed the order
 * belongs to the person asking, and the fan-out below addresses that label. Nothing in
 * the path depends on the client being well behaved.
 *
 * ## Who the client is, until #24
 *
 * There is no authentication in this project yet — the contract describes no customer
 * resource and carries no credentials. The identity therefore arrives in the socket.io
 * handshake, `io(url, { auth: { userId } })`, and is checked against the order's owner.
 * A socket with no `userId` is refused, and so is one naming somebody else's order.
 *
 * This is a placeholder and is written to be replaced: when #24 lands, the only thing
 * that changes is how `userIdOf` derives the id — a verified token instead of a claim —
 * and every refusal below keeps working unchanged.
 */

/** The answer a client receives in its `join` acknowledgement. */
export type JoinAck =
    | { ok: true; room: string }
    | {
          ok: false;
          error: 'unauthenticated' | 'bad-request' | 'not-found' | 'forbidden';
          detail: string;
      };

interface JoinRequest {
    orderId?: unknown;
}

@WebSocketGateway({
    // The browser demo in the README opens two tabs from the filesystem, and a headless
    // client sends no Origin at all. Nothing here is authenticated, so there is nothing
    // for an origin check to protect; #24 is where that changes.
    cors: { origin: '*' },
})
export class OrdersGateway implements OnGatewayInit, OnModuleDestroy {
    @WebSocketServer()
    private readonly server!: Server;

    private subscription: Subscription | undefined;

    constructor(
        private readonly events: OrderEventsService,
        private readonly orders: OrdersRepository,
    ) {}

    /**
     * One subscription for the whole gateway, not one per socket: the bus already knows
     * which order each event belongs to, and socket.io already knows who is in the room.
     */
    afterInit(): void {
        this.subscription = this.events.all().subscribe((event) => {
            this.server.to(roomOf(event.orderId)).emit(ORDER_STATUS_EVENT, toPayload(event));
        });
    }

    onModuleDestroy(): void {
        this.subscription?.unsubscribe();
    }

    @SubscribeMessage(JOIN_EVENT)
    async join(
        @ConnectedSocket() socket: Socket,
        @MessageBody() body: JoinRequest,
    ): Promise<JoinAck> {
        const userId = userIdOf(socket);

        if (userId === null) {
            return {
                ok: false,
                error: 'unauthenticated',
                detail: 'Connect with io(url, { auth: { userId } }) — an anonymous socket joins nothing.',
            };
        }

        const orderId = typeof body?.orderId === 'string' ? body.orderId : null;

        if (orderId === null) {
            return { ok: false, error: 'bad-request', detail: 'join expects { orderId }.' };
        }

        const order = await this.orders.findById(orderId);

        if (order === null) {
            return { ok: false, error: 'not-found', detail: `No order with id ${orderId}.` };
        }

        // The one check this whole gateway exists for.
        if (order.userId !== userId) {
            return {
                ok: false,
                error: 'forbidden',
                detail: `Order ${orderId} does not belong to user ${userId}.`,
            };
        }

        await socket.join(roomOf(orderId));

        return { ok: true, room: roomOf(orderId) };
    }
}

/**
 * The claimed identity, or null. A number is accepted because users.id is a bigint and a
 * JSON client will send it unquoted more often than not.
 */
function userIdOf(socket: Socket): string | null {
    const claimed: unknown = socket.handshake.auth?.userId;

    if (typeof claimed === 'string' && claimed.trim() !== '') {
        return claimed.trim();
    }

    if (typeof claimed === 'number' && Number.isInteger(claimed)) {
        return String(claimed);
    }

    return null;
}
