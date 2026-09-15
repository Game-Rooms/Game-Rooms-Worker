import { getObjectClass } from "../objects/objectTypes";
import type { WireParams } from "./types";
import type { Connection } from "./connection";
import { Acl, type AclRuleTuple } from "./acl";
import type { RoomState } from "./state";

/** The persisted, JSON-safe shape of a GameObject (see `toJSON`/`fromJSON`). */
export interface GameObjectJSON {
	type: string;
	key: string;
	value: unknown;
	version: number;
	locked: boolean;
	acl: AclRuleTuple[] | null;
}

/** The `entities` entry sent to a newly-joined player in `client/welcome`. */
export type WelcomeEntity = [string, WireParams, { locked: boolean }];

/**
 * Base class for every value tracked by a room. The ecast opcode schema is
 * `<type>/<method>` (e.g. "number/create", "text/update", "object/get"),
 * where `<type>` selects the concrete class below and `<method>` selects
 * which of its methods runs.
 *
 * Each class owns its own authorization rules, driven entirely by
 * `connection.role` (a plain string, not a hardcoded host/player split):
 * 
 *   - `privilegedRoles` - roles that bypass ACL/lock checks entirely and
 *     have full read/write authority (by default just "host"; a subclass or
 *     a future room feature could grant e.g. "moderator" the same rights by
 *     adding to this set).
 * 
 *   - `methodRoles` - which roles may invoke each `<type>/<method>` opcode at
 *     all, derived from `privilegedRoles`. The object router (see
 *     ../game/routers/objectRouter.ts) is fully generic - it just asks the
 *     class/instance what's allowed, instead of routers hardcoding per-role
 *     method lists.
 * 
 *   - `canRead` / `canWrite` layer the object's ACL (and lock state) on top
 *     of that, per-instance.
 */
export class GameObject {
	static kind: string = "object";							 // The `<type>` this class handles, e.g. "object", "text", "number". 
	static privilegedRoles: Set<string> = new Set(["host"]); // Roles with full, unconditional read/write access - ACL and lock don't apply to them

	/**
	 * Which roles may invoke each `<type>/<method>` opcode on this class.
	 * Anything not listed here for a given method is refused outright
	 * (before ACL/lock are even considered).
	 */
	static methodRoles: Record<string, string[]> = {
		create: [...this.privilegedRoles],
		update: [...this.privilegedRoles, "player"],
		get: 	[...this.privilegedRoles, "player"],
	};

	/**
	 * Available methods that can be invoked by a remote connection
	 */
	static availableMethods: string[] = [
		"create",
		"update",
		"get"
	];

	/** Whether `connection`'s role is even eligible to call `method` at all. */
	static isMethodAllowed(method: string, connection: Connection): boolean {
		const roles = this.methodRoles[method];
		return Boolean(roles) && roles.includes(connection.role);
	}

	/** Whether `connection`'s role bypasses ACL/lock checks for this class. */
	static isPrivileged(connection: Connection): boolean {
		return this.privilegedRoles.has(connection.role);
	}

	key: string;
	value: unknown;
	version: number;
	locked: boolean;
	acl: Acl | null; // null = visible/writable to everyone

	constructor(key: string) {
		this.key = key;
		this.value = null;
		this.version = -1;
		this.locked = false;
		this.acl = null;
	}

	get kind(): string {
		return (this.constructor as typeof GameObject).kind;
	}

	// -- (de)serialization ----------------------------------------------------

	static fromJSON(json: GameObjectJSON): GameObject {
		const obj = new this(json.key);
		Object.assign(obj, json);
		obj.acl = Acl.fromJSON(json.acl);
		return obj;
	}

	toJSON(): GameObjectJSON {
		return {
			type: this.kind,
			key: this.key,
			value: this.value,
			version: this.version,
			locked: this.locked,
			acl: this.acl ? this.acl.toJSON() : null,
		};
	}

	// -- permissions ------------------------------------------------------------

	/** Whether `connection` may read this object's current value (get / welcome visibility). */
	canRead(connection: Connection): boolean {
		return (this.constructor as typeof GameObject).isPrivileged(connection) || !this.acl || this.acl.allows(connection);
	}

	/** Whether `connection` may write (update/lock) this object. Privileged roles always may. */
	canWrite(connection: Connection): boolean {
		if ((this.constructor as typeof GameObject).isPrivileged(connection)) 
			return true;

		if (this.locked) 
			return false;

		return !this.acl || this.acl.allows(connection);
	}

	// -- mutation ---------------------------------------------------------------

	/**
	 * A privileged connection (the host, by default) created or fully
	 * overwrote this object - only ever invoked for privileged roles (see
	 * methodRoles/isPrivileged); callers don't need to re-check.
	 */
	applyCreate(params: WireParams): void {
		this.applyValue(params);
		this.acl = Acl.parse(params.acl);
	}

	/** A non-privileged connection replaced the value. Caller has already checked canWrite(). */
	applyUpdate(params: WireParams): void {
		this.applyValue(params);
	}

	private applyValue(params: WireParams): void {
		this.value = params.val;
		this.locked = false;
		this.version += 1;
	}

	// -- outgoing payload shaping -------------------------------------------------

	/** The `entities` entry sent to a newly-joined player in `client/welcome`. */
	toWelcomeEntity(): WelcomeEntity {
		// Upstream always reports the host (id 1) as the author here,
		// regardless of who last edited the object - kept for fidelity.
		return [this.kind, { key: this.key, val: this.value, version: this.version }, { locked: this.locked }];
	}

	/** Result payload broadcast to peers after a create/update. */
	toBroadcastResult(requestParams: WireParams): WireParams {
		return { ...requestParams, version: this.version };
	}

	/** Result payload for a "get" request (text/get, number/get, object/get). */
	toGetResult(requestParams: WireParams): WireParams {
		const result = { ...requestParams, val: this.value, version: this.version };
		delete result.acl;
		return result;
	}
}

/* ----------------------------------------------------------------------------------------------

/**
 * Shared dispatcher for the `<type>/<method>` object protocol (create/update/
 * get), used by the unified message router (see routers/router.ts). The
 * GameObject subclasses (see src/objects/*) own the actual rules - which
 * role may call which method (methodRoles), value validation, and ACL/lock
 * enforcement (canRead/canWrite). This module only handles the networking
 * side: acks, and notifying whichever side didn't originate the change.
 */
export function handleObjectOpcode(
	state: RoomState,
	connection: Connection,
	type: string,
	method: string,
	seq: number,
	params: WireParams,
): void {
	const ObjectClass = getObjectClass(type);
	if (!ObjectClass || !ObjectClass.isMethodAllowed(method, connection)) {
		// Not a method this role may call at all: no-op ack (every request
		// still gets acked, matching the rest of the protocol).
		replyOk(state, connection, seq);
		return;
	}

	if (method === "create") {
		handleCreate(state, connection, type, seq, params);
	} else if (method === "update") {
		handleUpdate(state, connection, type, seq, params);
	} else if (method === "get") {
		handleGet(state, connection, seq, params);
	}
}

function bumpPc(state: RoomState, connection: Connection): number {
	return connection.isHost ? state.bumpHostPc() : state.bumpGuestPc(connection.id);
}

function replyOk(state: RoomState, connection: Connection, seq: number): void {
	connection.sendOk(bumpPc(state, connection), seq);
}

function handleCreate(state: RoomState, connection: Connection, type: string, seq: number, params: WireParams): void {
	// Only a privileged role may reach here (see ObjectClass.methodRoles).
	const obj = state.ensureObject(params.key, type);
	obj.applyCreate(params, connection);

	replyOk(state, connection, seq);
	notifyOthers(state, connection, obj, obj.toBroadcastResult(params));
}

function handleUpdate(state: RoomState, connection: Connection, type: string, seq: number, params: WireParams): void {
	const ObjectClass = getObjectClass(type);
	let obj = state.getObject(params.key);
	let changed = false;

	if (ObjectClass && ObjectClass.isPrivileged(connection)) {
		// A privileged role always writes with full authority - same as
		// "create" - regardless of whether the object already existed.
		obj = state.ensureObject(params.key, type);
		obj.applyCreate(params, connection);
		changed = true;
	} else if (obj && obj.canWrite(connection)) {
		// Silently no-op if the object doesn't exist yet, is locked, or this
		// connection's ACL doesn't grant them write access - still always acked.
		obj.applyUpdate(params, connection);
		changed = true;
	}

	if (changed && obj) notifyOthers(state, connection, obj, obj.toBroadcastResult(params));
	replyOk(state, connection, seq);
}

function handleGet(state: RoomState, connection: Connection, seq: number, params: WireParams): void {
	const obj = state.getObject(params.key);
	if (!obj || !obj.canRead(connection)) 
		return; // no reply at all - matches upstream

	connection.send(bumpPc(state, connection), obj.kind, obj.toGetResult(params), { re: seq });
}

/** After a create/update, tell whichever side didn't originate it. */
function notifyOthers(state: RoomState, connection: Connection, obj: GameObject, result: WireParams): void {
	if (connection.isHost) {
		for (const player of state.players) {
			if (!obj.canRead(player)) 
				continue;

			player.send(state.bumpGuestPc(player.id), obj.kind, result);
		}
	} else {
		const host = state.host;
		if (host) 
			host.send(state.bumpHostPc(), obj.kind, result);
	}
}
