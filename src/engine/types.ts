/**
 * Shared, protocol-level types used across the game/ and objects/ modules.
 * Keeping them here (instead of duplicating inline) means every file agrees
 * on the exact shape of a wire message, a stored attachment, etc.
 */

/**
 * The body of a `create`/`update` request, or the payload passed straight
 * through on relay opcodes like `client/send`. This is genuinely arbitrary,
 * client-supplied JSON (its shape depends on the object `type` and the
 * game's own conventions), so it's typed as an open bag of properties rather
 * than pretending we know its exact shape.
 */
export type WireParams = Record<string, any>;

/** One parsed incoming WebSocket frame, before opcode-specific handling. */
export interface OpcodeMessage {
	opcode: string;
	seq: number;
	params?: WireParams;
}

/**
 * What we stash on a hibernating WebSocket via `serializeAttachment`, so a
 * woken-up Durable Object can rebuild its `Connection` objects without
 * having kept anything else in memory.
 */
export interface RoomAttachment {
	id: number;
	role: string;
	name?: string;
}

/** Summary returned by `Room.getJoinInfo()` for the plain-HTTP join check. */
export interface JoinInfo {
	appId: string;
	appTag: string;
	locked: boolean;
	full: boolean;
}

/** One entry in the room's `here` presence map, keyed by connection id. */
export type PresenceEntry =
	| { id: string; roles: { host: Record<string, never> } }
	| { id: string; roles: { player: { name: string | null } } };
