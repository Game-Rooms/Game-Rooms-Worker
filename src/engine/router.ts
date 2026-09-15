import { parseObjectOpcode } from "./opcodes";
import { handleObjectOpcode } from "./gameobject";
import type { RoomState } from "./state";
import type { Connection } from "./connection";
import type { OpcodeMessage, WireParams } from "./types";

/** One non-object opcode's handler function. */
type OpcodeHandler = (state: RoomState, connection: Connection, seq: number, params: WireParams) => void;

/** A non-object opcode entry: which roles may call it, and what runs when they do. */
interface OpcodeHandlerEntry {
	roles: string[];
	handle: OpcodeHandler;
}

/**
 * Non-object opcodes, keyed by name, each declaring which connection roles
 * may invoke them. There's a single message handler for every connection
 * regardless of role - permissions are just data (a role list) rather than
 * two separate host/player code paths having to agree on how to dispatch.
 * `<type>/<method>` object opcodes (number/create, text/get, etc.) are
 * handled separately by objectRouter.ts, which asks the GameObject class
 * itself which roles may call which method.
 */
const OPCODE_HANDLERS: Record<string, OpcodeHandlerEntry> = {
	lock: { roles: ["host", "player"], handle: handleLock },
	drop: { roles: ["host"], handle: handleDrop },
	"room/get-audience": { roles: ["host"], handle: handleGetAudience },
	"room/lock": { roles: ["host"], handle: handleRoomLock },
	"room/exit": { roles: ["host"], handle: handleRoomExit },
	"client/send": { roles: ["player"], handle: handleClientSend },
};

/** Handles one parsed message from any connection, host or player alike. */
export function handleMessage(state: RoomState, connection: Connection, message: OpcodeMessage): void {
	const { opcode, seq, params = {} } = message;

	const parsed = parseObjectOpcode(opcode);
	if (parsed) {
		handleObjectOpcode(state, connection, parsed.type, parsed.method, seq, params);
		return;
	}

	const entry = OPCODE_HANDLERS[opcode];
	if (entry && entry.roles.includes(connection.role)) {
		entry.handle(state, connection, seq, params);
		return;
	}

	// Unimplemented opcode, or this role isn't allowed to call it: default "ok" ack.
	console.info(`Unimplemented or unauthorized opcode: ${opcode}, role: ${connection.role}`);
	replyOk(state, connection, seq);
}

function bumpPc(state: RoomState, connection: Connection): number {
	return connection.isHost ? state.bumpHostPc() : state.bumpGuestPc(connection.id);
}

function replyOk(state: RoomState, connection: Connection, seq: number): void {
	connection.sendOk(bumpPc(state, connection), seq);
}

// -- lock ---------------------------------------------------------------------

function handleLock(state: RoomState, connection: Connection, seq: number, params: WireParams): void {
	const obj = state.getObject(params.key);
	if (obj && obj.canWrite(connection)) {
		obj.locked = true;
		notifyLock(state, connection, params.key);
	}

	replyOk(state, connection, seq);
}

/**
 * Tell whichever side didn't originate the lock. Host locks are silent
 * (matches upstream: the host doesn't need to be told about its own action
 * and there's no other host to notify); a player's lock notifies the host.
 */
function notifyLock(state: RoomState, connection: Connection, key: string): void {
	if (connection.isHost) 
		return;

	const host = state.host;
	if (host) 
		host.send(state.bumpHostPc(), "lock", { key, from: connection.id });
}

// -- host-only room management -------------------------------------------------

function handleDrop(state: RoomState, connection: Connection, seq: number, params: WireParams): void {
	state.dropObject(params.key);
	replyOk(state, connection, seq);
}

function handleGetAudience(state: RoomState, connection: Connection, seq: number): void {
	connection.send(state.bumpHostPc(), "room/get-audience", { connections: 0 }, { re: seq });
}

function handleRoomLock(state: RoomState, connection: Connection, seq: number): void {
	state.roomLocked = true;
	replyOk(state, connection, seq);
}

function handleRoomExit(state: RoomState, connection: Connection, seq: number): void {
	state.deactivate();
	for (const player of state.players) {
		player.close(1001, "room closed by host");
		state.removeConnection(player.id);
	}

	replyOk(state, connection, seq);
	connection.close(1000, "room closed by host");
}

// -- player -> host relay ------------------------------------------------------

function handleClientSend(state: RoomState, connection: Connection, seq: number, params: WireParams): void {
	const host = state.host;
	if (host)
		host.send(state.bumpHostPc(), "client/send", params);
	 
	replyOk(state, connection, seq);
}
