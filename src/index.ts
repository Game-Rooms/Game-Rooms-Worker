/**
 * Every room gets its own Durable Object instance (named after its 4-letter room code), 
 * so any number of rooms can run concurrently on one deployment.
 *
 *
 *   POST /api/v2/rooms                        			-> create a room, returns room code
 *   GET  /api/v2/app-configs/<app-id>          		-> generic app config
 *   GET  /api/v2/rooms/<code>                  		-> join info (locked/full/etc.)
 *   GET  /api/v2/rooms/<code>/ws?role=host             -> host WebSocket
 *   GET  /api/v2/rooms/<code>/ws?role=player&name=Bob  -> player WebSocket
 */

export { Room } from "./engine/room.js";

const ROOM_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ROOM_CODE_LENGTH = 4;

function generateRoomCode() {
	let code = "";
	for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
		code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
	}
	return code;
}

function jsonResponse(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
			"Access-Control-Allow-Origin": "*",
		},
	});
}

function getRoomStub(env, code) {
	const id = env.ROOMS.idFromName(code);
	return env.ROOMS.get(id);
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const path = url.pathname;
		const hostHeader = request.headers.get("Host") || url.host || "localhost";

		// --- Room creation ---------------------------------------------------
		if (request.method === "POST" && path === "/api/v2/rooms") {
			let data = {};
			try {
				data = await request.json();
			} catch {
				data = {};
			}

			const appId = data.appId || "";
			const appTag = data.appTag || "";
			const maxPlayers = data.maxPlayers || 0;

			// keep generating until we land on a room code that isn't already active
			let code = null;
			for (let attempt = 0; attempt < 10; attempt++) {
				const candidate = generateRoomCode();
				const stub = getRoomStub(env, candidate);
				const created = await stub.createRoom(appId, appTag, maxPlayers);
				if (created) {
					code = candidate;
					break;
				}
			}
			if (!code) {
				return jsonResponse({ ok: false, error: "could_not_allocate_room" }, 500);
			}

			return jsonResponse({
				ok: true,
				body: {
					host: hostHeader,
					code,
					token: "000000000000000000000000",
				},
			});
		}

		// --- App configs (static / generic) -----------------------------------
		if (path.startsWith("/api/v2/app-configs/")) {
			return jsonResponse({ ok: true, body: { settings: { serverUrl: hostHeader } } });
		}

		// --- Room join info + WebSocket upgrade -------------------------------
		if (path.startsWith("/api/v2/rooms/")) {
			const remainder = path.slice("/api/v2/rooms/".length);
			const parts = remainder.split("/").filter(Boolean);
			
			if (parts.length === 0) {
				console.warn("No room code specified in the request path.");
				return jsonResponse({ ok: false }, 404);
			}

			const code = parts[0].toUpperCase();
			const stub = getRoomStub(env, code);

			// WebSocket connection: /api/v2/rooms/<code>/ws?role=host|player&name=X
			if (parts.length > 1 && parts[1] === "ws") {
				// Room.fetch() inspects the Upgrade header + query string itself.
				return stub.fetch(request);
			}

			// Plain HTTP join-info request
			const info = await stub.getJoinInfo();
			if (!info) {
				console.warn(`Room not found for code: ${code}`);
				return jsonResponse({}, 404);
			}

			return jsonResponse({
				ok: true,
				body: {
					appId: info.appId,
					appTag: info.appTag,
					audienceEnabled: false,
					code,
					host: hostHeader,
					audienceHost: hostHeader,
					locked: info.locked,
					full: info.full,
					moderationEnabled: false,
					passwordRequired: false,
					twitchLocked: false,
					locale: "en",
					keepalive: false,
				},
			});
		}

		// --- Fallback ----------------------------------------------------------
		return jsonResponse({ ok: true, body: {} });
	},
};
