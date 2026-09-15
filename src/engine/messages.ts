import type { Connection } from "./connection";
import type { RoomState } from "./state";
import type { PresenceEntry, WireParams } from "./types";

/** Result payload for the host's `client/welcome` message. */
export interface HostWelcomeResult {
	id: number;
	secret: string;
	reconnect: boolean;
	deviceId: string;
	entities: Record<string, WireParams>;
	here: Record<string, PresenceEntry>;
	profile: null;
}

/** Result payload for a player's `client/welcome` message. */
export interface PlayerWelcomeResult {
	id: number;
	name: string | null;
	secret: string;
	reconnect: boolean;
	deviceId: string;
	entities: Record<string, WireParams>;
	here: Record<string, PresenceEntry>;
	profile: WireParams;
}

/** Result payload sent to the host when a player connects. */
export interface ClientConnectedResult {
	id: number;
	userId: string;
	name: string | null;
	role: string;
	reconnect: boolean;
	profile: WireParams;
}

/** Builders for the handful of fixed-shape protocol messages that aren't tied to a single GameObject. */

export function hostWelcomeResult(): HostWelcomeResult {
	return {
		id: 1,
		secret: "000000000000000000000000",
		reconnect: false,
		deviceId: "0000000000.0000000000000000000000",
		entities: {},
		here: {},
		profile: null,
	};
}

export function playerWelcomeResult(state: RoomState, connection: Connection): PlayerWelcomeResult {
	const entities: Record<string, WireParams> = {};
	for (const [key, obj] of state.visibleObjectEntries(connection)) {
		entities[key] = obj.toWelcomeEntity();
	}

	return {
		id: connection.id,
		name: connection.name,
		secret: "00000000-0000-0000-0000-000000000000",
		reconnect: false,
		deviceId: "0000000000.0000000000000000000000",
		entities,
		here: state.presenceMap(),
		profile: { id: connection.id, roles: { player: { name: connection.name } } },
	};
}

export function clientConnectedResult(connection: Connection): ClientConnectedResult {
	return {
		id: connection.id,
		userId: `00000000-0000-0000-0000-${String(connection.id).padStart(12, "0")}`,
		name: connection.name,
		role: "player",
		reconnect: false,
		profile: { id: connection.id, roles: { player: { name: connection.name } } },
	};
}
