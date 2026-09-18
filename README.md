# Game Rooms Worker

> A Cloudflare Workers + Durable Objects backend for creating realtime game rooms with HTTP room discovery and a lightweight WebSocket protocol.

This project provides the server-side runtime for room-based multiplayer or party-style games. It allocates short room codes, exposes join metadata over HTTP, and hosts a stateful WebSocket session per room where one host and multiple players can exchange game state using a compact opcode-driven protocol.

## Why this exists

Game clients often need a simple backend for room creation, player presence, and synchronized shared state without introducing a full database, message broker, or custom infrastructure stack. This Worker uses Cloudflare Durable Objects so each room has its own isolated state container and connection lifecycle.

## Highlights

- **Cloudflare-native room hosting** using one Durable Object instance per room code.
- **Short-code room creation** through a small HTTP API.
- **Realtime WebSocket protocol** for host/player sessions and object updates.
- **Built-in room state management** for connections, presence, lock state, and shared objects.
- **Role-aware permissions** so host and player actions can be gated by opcode and ACL rules.
- **Documented wire protocol** in [`/home/runner/work/Game-Rooms-Worker/Game-Rooms-Worker/.github/PROTOCOL.md`](/home/runner/work/Game-Rooms-Worker/Game-Rooms-Worker/.github/PROTOCOL.md).

## Architecture

```text
Game client
   |
   v
Cloudflare Worker
   |
   v
Durable Object per room code
   |
   +-- room metadata
   +-- connection tracking
   +-- shared objects
   +-- websocket message routing
```

The top-level Worker handles room creation, room lookup, and WebSocket upgrade routing. Each room code maps to a dedicated Durable Object instance that owns the room's active state, players, host connection, and in-room protocol handling.

## Quick start

### Prerequisites

- Node.js 18 or newer
- A Cloudflare account with Workers enabled
- Wrangler authentication (`npx wrangler login`)

### Install and run locally

```powershell
npm install
npx wrangler login
npm run dev
```

By default, Wrangler serves the Worker from `src/index.ts` using the configuration in [`wrangler.jsonc`](wrangler.jsonc).

### Deploy

```powershell
npm run deploy
```

## HTTP API

The Worker exposes a minimal HTTP surface for room lifecycle and bootstrap data:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v2/rooms` | Create a room and return its 4-letter code |
| `GET` | `/api/v2/app-configs/{appId}` | Return generic app configuration |
| `GET` | `/api/v2/rooms/{code}` | Return room join info such as `locked` and `full` |
| `GET` | `/api/v2/rooms/{code}/ws?role=host` | Open the host WebSocket session |
| `GET` | `/api/v2/rooms/{code}/ws?role=player&name=Bob` | Open a player WebSocket session |

Room creation returns the host domain, room code, and a placeholder token field for client compatibility. Room lookup returns metadata including the room's current lock and capacity status.

## WebSocket protocol

Once connected, clients communicate using JSON messages shaped around opcodes:

- **Client → server:** `{ opcode, seq, params }`
- **Server → client:** `{ pc, opcode, result, re? }`

The protocol supports:

- fixed lifecycle messages such as `client/welcome` and `client/connected`
- object operations such as `<type>/create`, `<type>/update`, and `<type>/get`
- room-level actions such as `room/lock`, `room/exit`, `drop`, and `client/send`
- ACL-based player visibility and write restrictions

For the full protocol contract, examples, and semantics, see [`PROTOCOL.md`](.github/PROTOCOL.md).

## Shared object model

Rooms maintain a flat collection of keyed objects. The current built-in object types are:

- `object`
- `text`
- `number`

Objects track:

- a unique `key`
- a typed value
- a monotonically increasing `version`
- an optional ACL
- a `locked` flag used to gate player updates

Hosts have full authority over room and object state. Players can only invoke the subset of operations allowed by their role and the target object's ACL/lock status.

## Development

Useful commands:

```powershell
npm run dev        # Start the local Wrangler development server
npm run deploy     # Deploy the Worker
node scripts/smoketest.js
```

The smoke test starts `wrangler dev`, creates a room, connects a host and player, and exercises the main protocol flow including create, update, get, lock, relay, drop, and room exit behavior.

## Project structure

- `src/index.ts` — HTTP routes, room code generation, and Durable Object lookup
- `src/engine/room.ts` — Durable Object room lifecycle and WebSocket handling
- `src/engine/router.ts` — non-object opcode dispatch
- `src/engine/gameobject.ts` — shared object behavior and object opcode handling
- `src/engine/state.ts` — persisted room state and connection/object bookkeeping
- `src/objects/` — concrete object types
- `.github/PROTOCOL.md` — protocol reference
- `scripts/smoketest.js` — end-to-end smoke test

## Configuration

The Worker configuration lives in [`wrangler.jsonc`](wrangler.jsonc). The current setup:

- registers the Worker as `game-rooms`
- uses `src/index.ts` as the entrypoint
- binds a Durable Object namespace named `ROOMS`
- creates the SQLite-backed Durable Object class `Room` through the `v1` migration

## Contributing

Issues and pull requests are welcome. When changing protocol or room behavior, keep [`PROTOCOL.md`](.github/PROTOCOL.md) aligned with the implementation.

## License

This project is distributed under the MIT License. See [`LICENSE`](LICENSE).
