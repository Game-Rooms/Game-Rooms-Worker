/**
 * Smoke test: spins up `wrangler dev`, creates a room over HTTP, connects a
 * host and a player over WebSocket, and drives them through the full
 * create/update/get/lock/client-send/drop/room-exit protocol, asserting the
 * expected response at each step.
 *
 * Run with: node scripts/smoketest.js
 */
import { spawn } from "node:child_process";

const PORT = 8787;
const BASE_HTTP = `http://127.0.0.1:${PORT}`;
const BASE_WS = `ws://127.0.0.1:${PORT}`;

let failures = 0;

function ok(condition, label, detail) {
	if (condition) {
		console.log(`  ok - ${label}`);
	} else {
		failures++;
		console.log(`  FAIL - ${label}`);
		if (detail !== undefined) console.log("    " + JSON.stringify(detail));
	}
}

function waitForServer(proc, timeoutMs = 30000) {
	return new Promise((resolve, reject) => {
		let buf = "";
		const timer = setTimeout(() => reject(new Error("timed out waiting for wrangler dev to start")), timeoutMs);
		function onData(chunk) {
			buf += chunk.toString();
			if (buf.includes("Ready on") || buf.includes(`http://127.0.0.1:${PORT}`) || buf.includes(`localhost:${PORT}`)) {
				clearTimeout(timer);
				proc.stdout.off("data", onData);
				resolve();
			}
		}
		proc.stdout.on("data", onData);
		proc.stderr.on("data", (chunk) => process.stderr.write(chunk));
	});
}

// Native WebSocket dispatches 'message' events immediately to whatever
// listeners are attached *at that instant* - it does not buffer events for
// listeners added later. So every socket gets one persistent listener as
// soon as it's opened, pushing into a queue; nextMessage() then just pulls
// from that queue (waiting if it's empty yet).
function attachQueue(ws) {
	ws._queue = [];
	ws._waiters = [];
	ws._closedError = null;
	ws.addEventListener("message", (event) => {
		const msg = JSON.parse(event.data);
		const waiter = ws._waiters.shift();
		if (waiter) waiter.resolve(msg);
		else ws._queue.push(msg);
	});
	ws.addEventListener("close", (event) => {
		ws._closedError = new Error(`websocket closed (code=${event.code} reason=${event.reason})`);
		for (const waiter of ws._waiters.splice(0)) waiter.reject(ws._closedError);
	});
	ws.addEventListener("error", () => {
		ws._closedError = ws._closedError || new Error("websocket error");
	});
}

function nextMessage(ws) {
	if (ws._queue.length > 0) return Promise.resolve(ws._queue.shift());
	if (ws._closedError) return Promise.reject(ws._closedError);
	return new Promise((resolve, reject) => ws._waiters.push({ resolve, reject }));
}

/** Waits up to timeoutMs for a message; resolves { replied:false } if none arrives,
 *  cleaning up its waiter so it can't steal a later, unrelated message. */
function expectNoMessage(ws, timeoutMs = 500) {
	if (ws._queue.length > 0) return Promise.resolve({ replied: true, m: ws._queue.shift() });
	return new Promise((resolve, reject) => {
		const waiter = {
			resolve: (m) => {
				clearTimeout(timer);
				resolve({ replied: true, m });
			},
			reject,
		};
		const timer = setTimeout(() => {
			const idx = ws._waiters.indexOf(waiter);
			if (idx !== -1) ws._waiters.splice(idx, 1);
			resolve({ replied: false });
		}, timeoutMs);
		ws._waiters.push(waiter);
	});
}

function openSocket(url) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		attachQueue(ws);
		ws.addEventListener("open", () => resolve(ws), { once: true });
		ws.addEventListener("error", (e) => reject(new Error("failed to open " + url)), { once: true });
	});
}

async function main() {
	console.log("starting wrangler dev...");
	const proc = spawn("npx", ["wrangler", "dev", "--port", String(PORT)], {
		cwd: new URL("..", import.meta.url),
		shell: true,
	});
	proc.on("error", (err) => console.error("failed to start wrangler dev:", err));

	try {
		await waitForServer(proc);
		console.log("server up, running smoke test\n");
		await runScenario();
	} finally {
		await killTree(proc);
	}

	console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILURE(S)`);
	process.exit(failures === 0 ? 0 : 1);
}

// `proc.kill()` alone only kills the top-level npx/shell wrapper on Windows,
// leaving its node/workerd descendants (and the port) alive. Kill the whole
// tree explicitly instead.
function killTree(proc) {
	return new Promise((resolve) => {
		if (process.platform === "win32") {
			const killer = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
			killer.on("exit", () => resolve());
			killer.on("error", () => resolve());
		} else {
			try {
				process.kill(-proc.pid, "SIGKILL");
			} catch {
				proc.kill("SIGKILL");
			}
			resolve();
		}
	});
}

async function runScenario() {
	// --- create room ---------------------------------------------------
	console.log("[room creation]");
	const createRes = await fetch(`${BASE_HTTP}/api/v2/rooms`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ appId: "test-app", appTag: "v1", maxPlayers: 1 }),
	});
	const createBody = await createRes.json();
	ok(createRes.status === 200, "POST /rooms returns 200", createRes.status);
	ok(createBody.ok === true, "response ok:true", createBody);
	const code = createBody.body && createBody.body.code;
	ok(typeof code === "string" && code.length === 4, "room code is a 4-char string", code);

	// --- join info before anyone connects -------------------------------
	const joinRes = await fetch(`${BASE_HTTP}/api/v2/rooms/${code}`);
	const joinBody = await joinRes.json();
	ok(joinBody.ok === true && joinBody.body.locked === false && joinBody.body.full === false, "join info reports unlocked/not full", joinBody);

	// --- host connects ---------------------------------------------------
	console.log("[host connect]");
	const host = await openSocket(`${BASE_WS}/api/v2/rooms/${code}/ws?role=host`);
	const hostWelcome = await nextMessage(host);
	ok(hostWelcome.opcode === "client/welcome", "host receives client/welcome", hostWelcome);
	ok(hostWelcome.result && hostWelcome.result.id === 1, "host id is 1", hostWelcome.result);

	// --- host creates a number object -------------------------------------
	console.log("[number/create]");
	host.send(JSON.stringify({ opcode: "number/create", seq: 1, params: { key: "score", val: 10, min: 0, max: 100, increment: 5 } }));
	const createAck = await nextMessage(host);
	ok(createAck.opcode === "ok" && createAck.re === 1, "host gets ok ack for create", createAck);

	// --- player joins ------------------------------------------------------
	console.log("[player connect]");
	const player = await openSocket(`${BASE_WS}/api/v2/rooms/${code}/ws?role=player&name=Bob`);
	const playerWelcome = await nextMessage(player);
	ok(playerWelcome.opcode === "client/welcome", "player receives client/welcome", playerWelcome);
	ok(playerWelcome.result && playerWelcome.result.id === 2, "player id is 2", playerWelcome.result);
	ok(playerWelcome.result.entities && playerWelcome.result.entities.score, "player welcome includes 'score' entity", playerWelcome.result.entities);
	const scoreEntity = playerWelcome.result.entities && playerWelcome.result.entities.score;
	ok(Array.isArray(scoreEntity) && scoreEntity[1] && scoreEntity[1].val === 10, "welcome entity has correct value", scoreEntity);

	const hostSeesConnect = await nextMessage(host);
	ok(hostSeesConnect.opcode === "client/connected", "host notified of player connect", hostSeesConnect);
	ok(hostSeesConnect.result && hostSeesConnect.result.id === 2, "client/connected has player id 2", hostSeesConnect.result);

	// --- player updates the object -----------------------------------------
	console.log("[number/update from player]");
	player.send(JSON.stringify({ opcode: "number/update", seq: 1, params: { key: "score", val: 42 } }));
	const playerUpdateAck = await nextMessage(player);
	ok(playerUpdateAck.opcode === "ok" && playerUpdateAck.re === 1, "player gets ok ack for update", playerUpdateAck);

	const hostSeesUpdate = await nextMessage(host);
	ok(hostSeesUpdate.opcode === "number" && hostSeesUpdate.result.val === 42, "host is broadcast the update", hostSeesUpdate);

	// --- host does a get -----------------------------------------------------
	console.log("[number/get]");
	host.send(JSON.stringify({ opcode: "number/get", seq: 2, params: { key: "score" } }));
	const getResult = await nextMessage(host);
	ok(getResult.opcode === "number" && getResult.re === 2 && getResult.result.val === 42, "get returns current value", getResult);

	// --- get on a missing key: expect NO reply --------------------------------
	console.log("[get on missing key]");
	host.send(JSON.stringify({ opcode: "number/get", seq: 3, params: { key: "does-not-exist" } }));
	const raceResult = await expectNoMessage(host);
	ok(raceResult.replied === false, "no reply is sent for a get on a missing key", raceResult);

	// --- lock ------------------------------------------------------------------
	console.log("[lock]");
	host.send(JSON.stringify({ opcode: "lock", seq: 4, params: { key: "score" } }));
	const lockAck = await nextMessage(host);
	ok(lockAck.opcode === "ok" && lockAck.re === 4, "host gets ok ack for lock", lockAck);

	// a locked object should silently ignore further player updates
	player.send(JSON.stringify({ opcode: "number/update", seq: 2, params: { key: "score", val: 999 } }));
	const playerLockedAck = await nextMessage(player);
	ok(playerLockedAck.opcode === "ok" && playerLockedAck.re === 2, "player still gets an ok ack even though locked", playerLockedAck);
	host.send(JSON.stringify({ opcode: "number/get", seq: 5, params: { key: "score" } }));
	const postLockGet = await nextMessage(host);
	ok(postLockGet.result.val === 42, "value unchanged after locked update attempt", postLockGet);

	// --- client/send relay -------------------------------------------------
	console.log("[client/send]");
	player.send(JSON.stringify({ opcode: "client/send", seq: 3, params: { hello: "world" } }));
	const relayed = await nextMessage(host);
	ok(relayed.opcode === "client/send" && relayed.result.hello === "world", "host receives relayed client/send", relayed);
	const senderAck = await nextMessage(player);
	ok(senderAck.opcode === "ok" && senderAck.re === 3, "player also gets its own ok ack for client/send", senderAck);

	// --- ACL enforcement: host-only object, hidden from players -------------
	console.log("[acl: host-only object]");
	host.send(JSON.stringify({ opcode: "text/create", seq: 10, params: { key: "secret", val: "shh", acl: ["reject", "role:player"] } }));
	const secretCreateAck = await nextMessage(host);
	ok(secretCreateAck.opcode === "ok" && secretCreateAck.re === 10, "host creates ACL'd object", secretCreateAck);

	// player must not be able to read it...
	player.send(JSON.stringify({ opcode: "text/get", seq: 4, params: { key: "secret" } }));
	const playerGetSecret = await expectNoMessage(player);
	ok(playerGetSecret.replied === false, "player get is denied (no reply) for host-only object", playerGetSecret);

	// ...nor write it (update is silently a no-op, still acked)...
	player.send(JSON.stringify({ opcode: "text/update", seq: 5, params: { key: "secret", val: "hacked" } }));
	const playerUpdateSecretAck = await nextMessage(player);
	ok(playerUpdateSecretAck.opcode === "ok" && playerUpdateSecretAck.re === 5, "player update ack (no-op) for host-only object", playerUpdateSecretAck);

	// ...and the value must be unaffected, confirmed via the host's own get.
	host.send(JSON.stringify({ opcode: "text/get", seq: 11, params: { key: "secret" } }));
	const hostGetSecret = await nextMessage(host);
	ok(hostGetSecret.result.val === "shh", "host still reads the original (unmodified) value", hostGetSecret);

	// player attempting to create an object at all must be rejected (host-only method)
	player.send(JSON.stringify({ opcode: "text/create", seq: 6, params: { key: "rogue", val: "nope" } }));
	const playerCreateAck = await nextMessage(player);
	ok(playerCreateAck.opcode === "ok" && playerCreateAck.result && Object.keys(playerCreateAck.result).length === 0, "player create attempt is a no-op ack", playerCreateAck);
	host.send(JSON.stringify({ opcode: "text/get", seq: 12, params: { key: "rogue" } }));
	const rogueGet = await expectNoMessage(host);
	ok(rogueGet.replied === false, "object from player's create attempt was never actually created", rogueGet);

	// --- drop --------------------------------------------------------------
	console.log("[drop]");
	host.send(JSON.stringify({ opcode: "drop", seq: 6, params: { key: "score" } }));
	const dropAck = await nextMessage(host);
	ok(dropAck.opcode === "ok" && dropAck.re === 6, "host gets ok ack for drop", dropAck);
	host.send(JSON.stringify({ opcode: "number/get", seq: 7, params: { key: "score" } }));
	const getAfterDrop = await expectNoMessage(host);
	ok(getAfterDrop.replied === false, "no reply for get after drop (object gone)", getAfterDrop);

	// --- room full check -----------------------------------------------------
	console.log("[room full]");
	const overflowRes = await fetch(`${BASE_HTTP}/api/v2/rooms/${code}`);
	const overflowBody = await overflowRes.json();
	ok(overflowBody.body.full === true, "room reports full at maxPlayers", overflowBody.body);

	const rejectedPlayer = await openSocket(`${BASE_WS}/api/v2/rooms/${code}/ws?role=player&name=Overflow`).catch((e) => e);
	ok(rejectedPlayer instanceof Error, "3rd player is rejected when room is full", rejectedPlayer);

	// --- room/exit -------------------------------------------------------------
	console.log("[room/exit]");
	const playerClosed = new Promise((resolve) => player.addEventListener("close", (e) => resolve(e), { once: true }));
	host.send(JSON.stringify({ opcode: "room/exit", seq: 8, params: {} }));
	const exitAck = await nextMessage(host);
	ok(exitAck.opcode === "ok" && exitAck.re === 8, "host gets ok ack for room/exit", exitAck);
	const closeEvent = await playerClosed;
	ok(closeEvent.code === 1001, "player socket is closed on room/exit", closeEvent.code);

	const postExitJoin = await fetch(`${BASE_HTTP}/api/v2/rooms/${code}`);
	ok(postExitJoin.status === 404, "room join info 404s after room/exit", postExitJoin.status);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
