import type { PresenceEntry, WireParams } from "./types";

/**
 * A single live WebSocket connection attached to a room: the host, or one
 * player. Its authorization identity is entirely `role` - a plain string,
 * not a hardcoded host/player split - so a room feature could hand out
 * additional roles (e.g. "moderator") without touching this class.
 */
export class Connection {
	id: number;
	role: string; // e.g. "host" | "player", but any string is valid
	ws: WebSocket;
	name: string | null;

	constructor(id: number, role: string, ws: WebSocket, name: string | null = null) {
		this.id = id;
		this.role = role;
		this.ws = ws;
		this.name = name;
	}

	/** Convenience accessor - equivalent to `role === "host"`. */
	get isHost(): boolean {
		return this.role === "host";
	}

	/** This connection's entry in the room's `here` presence map. */
	presence(): PresenceEntry {
		return this.isHost
			? { id: String(this.id), roles: { host: {} } }
			: { id: String(this.id), roles: { player: { name: this.name } } };
	}

	/**
	 * Send a message frame to this connection.
	 *
	 * @param pc - the per-connection sequence counter to stamp on the frame.
	 * @param opcode - the message's opcode, e.g. "client/welcome".
	 * @param result - the opcode-specific payload.
	 * @param extra - additional top-level fields to merge in (e.g. `{ re: seq }`).
	 */
	send(pc: number, opcode: string, result: WireParams, extra: WireParams = {}): void {
		this.ws.send(JSON.stringify({ pc, opcode, result, ...extra }));
	}

	/** Send the standard "ok" ack in reply to a request with sequence number `seq`. */
	sendOk(pc: number, seq: number): void {
		this.send(pc, "ok", {}, { re: seq });
	}

	close(code?: number, reason?: string): void {
		try {
			this.ws.close(code, reason);
		} catch {
			// socket may already be closed/closing - safe to ignore
		}
	}
}
