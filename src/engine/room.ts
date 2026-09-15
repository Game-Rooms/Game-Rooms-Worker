/**
 * Room - a Durable Object representing one Game Room instance.
 *
 * This class only handles Durable Object plumbing (persistence, the
 * WebSocket lifecycle, and wiring messages to the right router). 
 *
 *   - RoomState   the room's persisted data (identity, objects, players)
 *   - GameObject  one tracked value (object/text/number) and its framing rules
 *   - Connection  a live WebSocket + the id/role/name it belongs to
 *   - Messages    builders for the fixed-shape welcome/connected messages
 *   - router      a single role-driven opcode handler shared by every connection
 *
 * Every room code gets its own Room instance, so any number of rooms can run
 * concurrently, each fully isolated from the others.
 */

import { DurableObject } from "cloudflare:workers";
import { Connection } from "./connection";
import { RoomState } from "./state";
import { handleMessage } from "./router";
import { hostWelcomeResult, playerWelcomeResult, clientConnectedResult } from "./messages";
import type { JoinInfo, RoomAttachment } from "./types";

const STORAGE_KEY = "state";

/** Bindings available to this Worker (see wrangler.jsonc). */
export interface Env {
	ROOMS: DurableObjectNamespace<Room>;
}

export class Room extends DurableObject<Env> {
	private state: RoomState | null; // lazily loaded room state (see ensureLoaded)
	private pendingSockets: WebSocket[];

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.state = null;

		// WebSockets survive hibernation; our in-memory room state does not, so
		// we stash the raw sockets here and re-attach them once state is loaded.
		this.pendingSockets = this.ctx.getWebSockets();
	}

	private async ensureLoaded(): Promise<void> {
		if (this.state) 
			return;

		const stored = await this.ctx.storage.get<ReturnType<RoomState["toJSON"]>>(STORAGE_KEY);
		this.state = RoomState.fromJSON(stored ?? null);

		for (const ws of this.pendingSockets) {
			const attachment = ws.deserializeAttachment() as RoomAttachment | null;
			if (attachment && attachment.id !== undefined) {
				this.state.addConnection(new Connection(attachment.id, attachment.role, ws, attachment.name ?? null));
			}
		}
		this.pendingSockets = [];
	}

	private async persist(): Promise<void> {
		await this.ctx.storage.put(STORAGE_KEY, this.requireState().toJSON());
	}

	/** Narrow `this.state` to non-null for callers that already awaited `ensureLoaded()`. */
	private requireState(): RoomState {
		if (!this.state) 
			throw new Error("Room state accessed before ensureLoaded()");

		return this.state;
	}

	// -- RPC methods, called directly from the Worker's fetch handler ------

	async createRoom(appId: string, appTag: string, maxPlayers: number): Promise<boolean> {
		await this.ensureLoaded();
		const state = this.requireState();

		if (state.isActive) return false; // this room code is already in use
		state.activate(appId, appTag, maxPlayers);
		await this.persist();
		return true;
	}

	async getJoinInfo(): Promise<JoinInfo | null> {
		await this.ensureLoaded();
		const state = this.requireState();

		if (!state.isActive) 
		{
			console.warn("Attempted to get join info for an inactive room.");
			return null;
		}
		return {
			appId: state.appId,
			appTag: state.appTag,
			locked: state.roomLocked,
			full: state.isFull,
		};
	}

	// -- WebSocket upgrade --------------------------------------------------

	async fetch(request: Request): Promise<Response> {
		if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
			return new Response("expected websocket upgrade", { status: 400 });
		}

		await this.ensureLoaded();
		const state = this.requireState();
		if (!state.isActive) {
			return new Response("room is not active", { status: 404 });
		}

		const url = new URL(request.url);
		const role = url.searchParams.get("role") || "";
		const name = url.searchParams.get("name") || "";

		const [client, server] = Object.values(new WebSocketPair());

		if (role === "host") {
			await this.acceptHost(server);
		} else if (role === "player") {
			if (!(await this.acceptPlayer(server, name))) {
				return new Response("room is locked or full", { status: 403 });
			}
		} else {
			return new Response("role query param must be 'host' or 'player'", { status: 400 });
		}

		return new Response(null, { status: 101, webSocket: client });
	}

	private async acceptHost(ws: WebSocket): Promise<void> {
		const state = this.requireState();

		for (const player of state.players) {
			player.close(1001, "host reconnected, room reset");
			state.removeConnection(player.id);
		}
		state.resetForNewHost();

		this.ctx.acceptWebSocket(ws);
		ws.serializeAttachment({ id: 1, role: "host" } satisfies RoomAttachment);
		const connection = new Connection(1, "host", ws);
		state.addConnection(connection);

		connection.send(state.bumpHostPc(), "client/welcome", hostWelcomeResult());
		await this.persist();
	}

	private async acceptPlayer(ws: WebSocket, name: string): Promise<boolean> {
		const state = this.requireState();
		if (state.roomLocked || state.isFull) 
			return false;

		const id = state.nextPlayerId();
		const username = name || `PLAYER ${id - 1}`;
		state.registerPlayerJoin(id);

		this.ctx.acceptWebSocket(ws);
		ws.serializeAttachment({ id, role: "player", name: username } satisfies RoomAttachment);
		const connection = new Connection(id, "player", ws, username);
		state.addConnection(connection);

		connection.send(state.bumpGuestPc(id), "client/welcome", playerWelcomeResult(state, connection));

		const host = state.host;
		if (host) 
			host.send(state.bumpHostPc(), "client/connected", clientConnectedResult(connection));

		await this.persist();
		return true;
	}

	// -- WebSocket message / close handlers (hibernation API) --------------

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		await this.ensureLoaded();
		const state = this.requireState();

		let parsed;
		try {
			parsed = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
		} catch {
			return; // ignore malformed frames
		}

		const attachment = ws.deserializeAttachment() as RoomAttachment | null;
		const connection = attachment ? state.getConnection(attachment.id) : undefined;
		if (!connection) 
			return;

		handleMessage(state, connection, parsed);

		await this.persist();
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
		ws.close(code, reason);
		await this.ensureLoaded();
		const state = this.requireState();

		const attachment = ws.deserializeAttachment() as RoomAttachment | null;
		const connection = attachment ? state.getConnection(attachment.id) : undefined;
		if (!connection) return;

		state.removeConnection(connection.id);
		if (connection.isHost) {
			// Matches upstream: the room ends when the host disconnects.
			state.deactivate();
			for (const player of state.players) {
				player.close(1001, "host disconnected");
				state.removeConnection(player.id);
			}
		}

		await this.persist();
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		try {
			ws.close(1011, "websocket error");
		} catch {
			// socket may already be closed/closing - safe to ignore
		}
	}
}
