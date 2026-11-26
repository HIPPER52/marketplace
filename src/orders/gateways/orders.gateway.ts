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
import { Role } from '../../auth/constants/role.constant';
import { Authenticator } from '../../auth/services/authenticator.service';
import {
    JOIN_EVENT,
    JoinRefusal,
    ORDER_STATUS_EVENT,
    roomOf,
} from '../constants/realtime.constant';
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
 * ## Who the client is
 *
 * The same access token the HTTP routes take, handed over in the socket.io handshake:
 * `io(url, { auth: { token } })`. It goes through the identical chain — pinned algorithm,
 * issuer, audience, expiry, denylist, and the role read from the database — because that
 * chain is a service rather than code inside a guard. Until this assignment the handshake
 * carried `auth: { userId }`, a claim exactly as strong as the client's honesty; the
 * refusals below did not move, only what makes them trustworthy.
 *
 * A handshake carries no status code, so a refusal is the `join` acknowledgement's own
 * shape and `Authenticator.tryIdentify` answers `null` rather than throwing.
 */

/** The answer a client receives in its `join` acknowledgement. */
export type JoinAck =
    | { ok: true; room: string }
    | {
          ok: false;
          error: JoinRefusal;
          detail: string;
      };

interface JoinRequest {
    orderId?: unknown;
}

@WebSocketGateway({
    // The browser demo in the README opens two tabs from the filesystem, and a headless
    // client sends no Origin at all. What protects a room is the token in the handshake,
    // which no other origin has; an origin allowlist would be a second, weaker fence
    // around the same thing.
    cors: { origin: '*' },
})
export class OrdersGateway implements OnGatewayInit, OnModuleDestroy {
    @WebSocketServer()
    private readonly server!: Server;

    private subscription: Subscription | undefined;

    constructor(
        private readonly events: OrderEventsService,
        private readonly orders: OrdersRepository,
        private readonly authenticator: Authenticator,
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
        const principal = await this.authenticator.tryIdentify(socket.handshake.auth?.token);

        if (principal === null) {
            return {
                ok: false,
                error: JoinRefusal.Unauthenticated,
                detail: 'Present a valid access token as auth.token in the handshake.',
            };
        }

        const orderId = typeof body?.orderId === 'string' ? body.orderId : null;

        if (orderId === null) {
            return {
                ok: false,
                error: JoinRefusal.BadRequest,
                detail: 'join expects { orderId }.',
            };
        }

        const order = await this.orders.findById(orderId);

        if (order === null) {
            return {
                ok: false,
                error: JoinRefusal.NotFound,
                detail: `No order with id ${orderId}.`,
            };
        }

        // The one check this whole gateway exists for.
        if (order.userId !== principal.userId && principal.role !== Role.Admin) {
            return {
                ok: false,
                error: JoinRefusal.Forbidden,
                detail: `Order ${orderId} does not belong to you.`,
            };
        }

        await socket.join(roomOf(orderId));

        return { ok: true, room: roomOf(orderId) };
    }
}
