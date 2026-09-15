import { createGameObject, gameObjectFromJSON } from "..//objects/objectTypes";
import { GameObject, type GameObjectJSON } from "./gameobject";
import type { Connection } from "./connection";
import type { PresenceEntry } from "./types";

/** The persisted, JSON-safe shape of a RoomState (see `toJSON`/`fromJSON`). */
export interface RoomStateJSON {
	appId: string;
	appTag: string;
	maxPlayers: number;
	roomLocked: boolean;
	playerCount: number;
	hostPc: number;
	guestPc: Record<string, number>;
	objects: Record<string, GameObjectJSON>;
}

/**
 * All state for a single game room: its identity (appId/appTag/maxPlayers),
 * its tracked objects, and its live connections. Everything except
 * `connections` is persisted to Durable Object storage so a hibernated room
 * resumes correctly when a new message wakes it back up.
 */
export class RoomState {
	appId!: string;
	appTag!: string;
	maxPlayers!: number;
	roomLocked!: boolean;
	playerCount!: number;
	hostPc!: number;
	guestPc!: Record<string, number>; // playerId (string) -> sequence counter

	objects: Map<string, GameObject>;
	connections: Map<number, Connection>; // transient, rebuilt on wake

	constructor() {
		this.resetFields();
		this.objects = new Map();
		this.connections = new Map();
	}

	private resetFields(): void {
		this.appId = "";
		this.appTag = "";
		this.maxPlayers = 0;
		this.roomLocked = false;
		this.playerCount = 0;
		this.hostPc = 2;
		this.guestPc = {};
	}

	// -- (de)serialization ---------------------------------------------------

	toJSON(): RoomStateJSON {
		return {
			appId: this.appId,
			appTag: this.appTag,
			maxPlayers: this.maxPlayers,
			roomLocked: this.roomLocked,
			playerCount: this.playerCount,
			hostPc: this.hostPc,
			guestPc: this.guestPc,
			objects: Object.fromEntries([...this.objects].map(([key, obj]) => [key, obj.toJSON()])),
		};
	}

	static fromJSON(json: RoomStateJSON | null | undefined): RoomState {
		const state = new RoomState();
		if (!json) return state;

		Object.assign(state, json);
		state.objects = new Map(Object.entries(json.objects || {}).map(([key, obj]) => [key, gameObjectFromJSON(obj)]));
		return state;
	}

	// -- room lifecycle --------------------------------------------------------

	get isActive(): boolean {
		return Boolean(this.appId);
	}

	get isFull(): boolean {
		return Boolean(this.maxPlayers) && this.playerCount >= this.maxPlayers;
	}

	/** Allocate this room for a brand new game. */
	activate(appId: string, appTag: string, maxPlayers: number): void {
		this.resetFields();
		this.objects = new Map();
		this.appId = appId || "";
		this.appTag = appTag || "";
		this.maxPlayers = maxPlayers || 0;
	}

	/** Wipe game data but keep the room's identity - used when the host (re)connects. */
	resetForNewHost(): void {
		const { appId, appTag, maxPlayers } = this;
		this.resetFields();
		this.objects = new Map();
		this.appId = appId;
		this.appTag = appTag;
		this.maxPlayers = maxPlayers;
	}

	/** Free up this room code so it can be reused by a future room. */
	deactivate(): void {
		this.appId = "";
	}

	// -- players -----------------------------------------------------------

	/** The id the next player to join will be assigned. */
	nextPlayerId(): number {
		return 1 + this.playerCount + 1;
	}

	registerPlayerJoin(id: number): void {
		this.playerCount += 1;
		this.guestPc[String(id)] = 2;
	}

	// -- sequence numbers ("pc") ----------------------------------------------

	bumpHostPc(): number {
		this.hostPc += 1;
		return this.hostPc;
	}

	bumpGuestPc(id: number): number {
		const key = String(id);
		this.guestPc[key] = (this.guestPc[key] ?? 2) + 1;
		return this.guestPc[key];
	}

	/** Bump whichever sequence counter belongs to the given connection id. */
	bumpPcFor(id: number): number {
		return id === HOST_ID ? this.bumpHostPc() : this.bumpGuestPc(id);
	}

	// -- objects -------------------------------------------------------------

	getObject(key: string): GameObject | undefined {
		return this.objects.get(key);
	}

	ensureObject(key: string, type: string): GameObject {
		let obj = this.objects.get(key);
		if (!obj) {
			obj = createGameObject(type, key);
			this.objects.set(key, obj);
		}
		return obj;
	}

	dropObject(key: string): void {
		this.objects.delete(key);
	}

	/** [key, GameObject] pairs a given connection is allowed to read. */
	visibleObjectEntries(connection: Connection): [string, GameObject][] {
		return [...this.objects.entries()].filter(([, obj]) => obj.canRead(connection));
	}

	// -- connections (transient, never persisted) ----------------------------

	addConnection(connection: Connection): void {
		this.connections.set(connection.id, connection);
	}

	removeConnection(id: number): void {
		this.connections.delete(id);
	}

	getConnection(id: number): Connection | undefined {
		return this.connections.get(id);
	}

	get host(): Connection | undefined {
		return this.connections.get(HOST_ID);
	}

	get players(): Connection[] {
		return [...this.connections.values()].filter((connection) => !connection.isHost);
	}

	/** The `here` presence map sent to newly-joined players. */
	presenceMap(): Record<string, PresenceEntry> {
		const here: Record<string, PresenceEntry> = {};
		for (const connection of this.connections.values()) {
			here[String(connection.id)] = connection.presence();
		}

		return here;
	}
}
