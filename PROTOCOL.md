# Game Rooms Protocol

This document specifies the wire protocol implemented by this Cloudflare
Worker so that a client SDK (host-side and/or player-side) can be written
against it without reading the server source. It covers the HTTP API used
to create/discover rooms and the WebSocket protocol used for realtime game
state.

The protocol is a small, ecast-style `<type>/<method>` opcode system: every
WebSocket message is `{ opcode, seq, params }` from the client and
`{ pc, opcode, result, re? }` from the server. There is no built-in
game logic — the server just tracks a set of arbitrary key/value "objects"
(`object`, `text`, `number`) with optional per-object access control, and
relays create/update/get/lock/relay traffic between one **host** and any
number of **players**.

- Base URL: whatever host the Worker is deployed to (e.g.
  `https://your-worker.example.workers.dev`). The Worker also happily
  answers on `http://127.0.0.1:8787` under `wrangler dev`.
- Transport: plain HTTP/JSON for room creation/lookup, WebSocket (JSON text
  frames) for realtime traffic.
- Room codes: 4 uppercase letters (`A`-`Z`), e.g. `"WXYZ"`. Case-insensitive
  on input (the server upper-cases whatever you send).

---

## 1. HTTP API

All responses are JSON with `Content-Type: application/json` and
`Access-Control-Allow-Origin: *`. There is no `OPTIONS` handler. As
implemented, cross-origin browser calls to `POST /api/v2/rooms` are not
supported because JSON requests preflight, and browser requests with custom
headers are unsupported for the same reason.

Every JSON response has the shape `{ ok: boolean, body?: {...}, error?: string }`
except the plain 404 fallbacks noted below, which are `{}`.

### 1.1 Create a room

```
POST /api/v2/rooms
Content-Type: application/json

{ "appId": "my-game", "appTag": "v1.0", "maxPlayers": 8 }
```

- `appId` (string, optional, default `""`) — your game's identifier. Purely
  informational; the server never validates it.
- `appTag` (string, optional, default `""`) — a secondary tag (e.g. version
  string). Also purely informational.
- `maxPlayers` (number, optional, default `0`) — `0` means unlimited.

Response (`200`):

```json
{
  "ok": true,
  "body": {
    "host": "your-worker.example.workers.dev",
    "code": "WXYZ",
    "token": "000000000000000000000000"
  }
}
```

- `code` — the freshly-allocated 4-letter room code. The server retries up
  to 10 times internally to avoid colliding with an already-active room; a
  code becomes reusable again once its room's host disconnects (see §2.4).
- `host` — echoes back the `Host` request header (i.e. the host/domain
  clients should connect to for this room's HTTP/WS endpoints).
- `token` — always the fixed placeholder string
  `"000000000000000000000000"` in this implementation. It exists for wire
  compatibility but carries no real auth semantics — don't rely on it.

Failure (`500`): `{ "ok": false, "error": "could_not_allocate_room" }` if no
free code could be found after 10 attempts.

### 1.2 App config (generic, static)

```
GET /api/v2/app-configs/<app-id>
```

Always returns `200`:

```json
{ "ok": true, "body": { "settings": { "serverUrl": "your-worker.example.workers.dev" } } }
```

`<app-id>` is accepted but otherwise ignored — this endpoint exists for
wire compatibility with clients that fetch a per-app config before doing
anything else; there is currently no per-app configuration data.

### 1.3 Room join info

```
GET /api/v2/rooms/<code>
```

- `200` with the room's current status if the room is active:

```json
{
  "ok": true,
  "body": {
    "appId": "my-game",
    "appTag": "v1.0",
    "audienceEnabled": false,
    "code": "WXYZ",
    "host": "your-worker.example.workers.dev",
    "audienceHost": "your-worker.example.workers.dev",
    "locked": false,
    "full": false,
    "moderationEnabled": false,
    "passwordRequired": false,
    "twitchLocked": false,
    "locale": "en",
    "keepalive": false
  }
}
```

  Fields fixed at these constant values in this implementation (present for
  wire compatibility, not currently configurable): `audienceEnabled`,
  `moderationEnabled`, `passwordRequired`, `twitchLocked`, `locale`,
  `keepalive`.

  `locked` and `full` reflect whether new players may currently join:
  `locked` follows `room/lock` (§5) and stays `true` for the rest of the
  active room session, while `full` becomes `true` once the room reaches
  `maxPlayers` (§2.2).

- `404` `{}` if the room code doesn't correspond to an active room (never
  created, or the host has since disconnected/exited).

A client SDK should poll or call this once before attempting to open a
WebSocket, to surface "room not found" / "room locked" / "room full" to
the user with a normal HTTP error rather than a failed WS upgrade — but the
WS upgrade itself also enforces these rules (see §2).

### 1.4 Everything else

Any other path returns `200 { "ok": true, "body": {} }`. Don't rely on this
— it's a catch-all, not a documented no-op endpoint.

---

## 2. WebSocket protocol

### 2.1 Connecting

```
GET /api/v2/rooms/<code>/ws?role=host
GET /api/v2/rooms/<code>/ws?role=player&name=Bob
```

Upgrade this request to a WebSocket the same way you would any other (e.g.
`new WebSocket(url)` in a browser — the `Upgrade` header is handled by the
runtime, not something you set manually).

Query parameters:

- `role` — **required**, must be exactly `"host"` or `"player"`. Anything
  else → `400`.
- `name` — optional, **player only**. Free-text display name. Defaults to
  `"PLAYER " + (id - 1)` if omitted (so the first player with no name is
  `"PLAYER 1"`, matching their assigned id being `2`).

Upgrade failure responses (plain text bodies, not JSON):

| Status | Condition |
|---|---|
| `400` | `Upgrade` header isn't `websocket` |
| `404` | Room code has no active room |
| `403` | `role=player` and the room is locked or full |
| `400` | `role` missing or not `host`/`player` |

### 2.2 Roles

- **Host** — exactly one per room, always assigned connection id `1`.
  Connecting as host while a previous host (or players) are still connected
  **evicts everyone**: existing players are closed with code `1001`
  ("host reconnected, room reset") and all room objects/state are wiped
  (`appId`/`appTag`/`maxPlayers` are preserved, everything else resets) —
  i.e. connecting as host always starts a fresh session for that room code,
  it does not resume the previous one.
- **Player** — any number, assigned sequential ids starting at `2` (id `1`
  is reserved for the host). A player connection is rejected outright
  (`403`, no WebSocket ever established) if the room is locked
  (`room/lock`, see §2.6) or already at `maxPlayers`.
- There is no reconnect/resume support: every welcome message includes
  `reconnect: false` unconditionally, and losing your socket loses your
  connection id permanently (a fresh reconnect gets a new player id, or, if
  reconnecting as host, resets the whole room).

### 2.3 The `client/welcome` message

Immediately upon a successful upgrade, the server sends exactly one
`client/welcome` message to the new connection (before anything else can
arrive). Nothing else should be sent by the client before receiving this.

**Host welcome result:**

```json
{
  "pc": 3,
  "opcode": "client/welcome",
  "result": {
    "id": 1,
    "secret": "000000000000000000000000",
    "reconnect": false,
    "deviceId": "0000000000.0000000000000000000000",
    "entities": {},
    "here": {},
    "profile": null
  }
}
```

The host's `entities`/`here` are always empty since connecting as host
always starts a fresh room (see §2.2 and §6).

**Player welcome result:**

```json
{
  "pc": 3,
  "opcode": "client/welcome",
  "result": {
    "id": 2,
    "name": "Bob",
    "secret": "00000000-0000-0000-0000-000000000000",
    "reconnect": false,
    "deviceId": "0000000000.0000000000000000000000",
    "entities": {
      "score": ["number", { "key": "score", "val": 10, "version": 0 }, { "locked": false }]
    },
    "here": {
      "1": { "id": "1", "roles": { "host": {} } },
      "2": { "id": "2", "roles": { "player": { "name": "Bob" } } }
    },
    "profile": { "id": 2, "roles": { "player": { "name": "Bob" } } }
  }
}
```

- `id` — this connection's permanent id for the session (host is always
  `1`; players are `2, 3, 4, ...` in join order, never reused within a
  session even if earlier players leave).
- `secret`/`deviceId` — fixed placeholder values in this implementation
  (not real per-connection secrets/device ids). Present for wire
  compatibility only.
- `entities` — every currently-visible object this connection is allowed to
  read (per its ACL — see §3.4), keyed by object key, each value a 3-tuple
  `[type, { key, val, version }, { locked }]`. This is your full initial
  state snapshot; there is no separate "sync" step.
- `here` — a presence map of every currently-connected connection
  (including yourself), keyed by connection id as a string. Each entry is
  `{ id: "<id>", roles: { host: {} } }` for the host or
  `{ id: "<id>", roles: { player: { name } } }` for a player.
- `profile` — `null` for the host; `{ id, roles: { player: { name } } }` for
  a player.

### 2.4 `client/connected` (host-only notification)

Whenever a player successfully joins, the **host** (and only the host)
receives:

```json
{
  "pc": 4,
  "opcode": "client/connected",
  "result": {
    "id": 2,
    "userId": "00000000-0000-0000-0000-000000000002",
    "name": "Bob",
    "role": "player",
    "reconnect": false,
    "profile": { "id": 2, "roles": { "player": { "name": "Bob" } } }
  }
}
```

`userId` is a fixed-format placeholder GUID whose last 12 hex digits are the
connection id, zero-padded — not a real stable user identity.

There is no corresponding "player disconnected" notification opcode in this
implementation — a client SDK that wants to track departures should derive
it from absence rather than expect an explicit event. (The host itself
disconnecting ends the room entirely — see §2.7.)

### 2.5 Message envelope

**Client → server** (you send this):

```json
{ "opcode": "number/update", "seq": 7, "params": { "key": "score", "val": 42 } }
```

- `opcode` (string, required) — see §3/§4 for the full opcode list.
- `seq` (number) — a client-chosen correlation id. Echoed back as `re` on
  the direct reply to this specific message (not on broadcasts to other
  connections). Pick any monotonically increasing integer per-connection;
  the server does not validate or dedupe it.
- `params` (object, optional, default `{}`) — opcode-specific payload, see
  below.

Malformed JSON frames are silently dropped (no error is sent back).

**Server → client** (you receive this):

```json
{ "pc": 5, "opcode": "number", "result": { "key": "score", "val": 42, "version": 1 }, "re": 7 }
```

- `pc` — a **per-connection** monotonically increasing sequence counter
  maintained by the server (starts at `2`, so the very first message —
  `client/welcome` — arrives with `pc: 3`). Every message sent to a given
  connection, including replies and broadcasts, increments and stamps this
  counter. Treat it as an ordering hint / gap-detector for that specific
  connection's message stream, not as syncable across connections (host and
  each player each have their own independent `pc` sequence).
- `opcode` — either `"ok"` (generic acknowledgement, see below), the object
  `kind` (`"object"` / `"text"` / `"number"`) for object protocol
  broadcasts/get-results, or a fixed message name (`client/welcome`,
  `client/connected`, `client/send`, `lock`, `room/get-audience`).
- `result` — opcode-specific payload (may be `{}`).
- `re` — **only present when this message is a direct reply** to a specific
  client request; its value is that request's `seq`. Broadcasts to *other*
  connections (e.g. the host being told about a player's update) do **not**
  carry `re`.

**Every** client request that reaches the opcode router gets exactly one
reply to the sender: either the opcode-specific result, or, for anything
not otherwise handled below, a generic ack:

```json
{ "pc": 6, "opcode": "ok", "result": {}, "re": 7 }
```

This applies to unimplemented opcodes and to opcodes/methods the caller's
role isn't allowed to invoke — they are **not** rejected with an error,
they're just silently no-op'd and acked as `"ok"`. The one documented
exception is `<type>/get` on a key the caller can't read (missing key, or
denied by ACL): that gets **no reply at all**, not even an ack (see §3.3).
A client SDK should therefore implement `get` calls with a timeout, not an
indefinite wait.

### 2.6 Room object model recap

A room holds a flat map of **objects**, each identified by an
application-chosen string `key` (e.g. `"score"`, `"board"`, arbitrary).
Each object has:

- `type` — one of `"object"`, `"text"`, `"number"` (see §4 — behaviorally
  identical today, `type` only affects the wire opcode prefix and the
  broadcast `opcode`/`kind`).
- `val` — arbitrary JSON value chosen by whoever created/updated it. The
  server does not validate or interpret it (e.g. `"number"` objects are
  **not** actually required to hold a JS number — any extra `params` like
  `min`/`max`/`increment` you send on create/update are simply echoed back
  in the broadcast/result payload, never enforced server-side).
- `version` — starts at `0` on first `create`, increments by 1 on every
  subsequent `create` or `update` (including a privileged `update` that
  behaves like a `create` — see §3.2).
- `locked` — `false` by default; see §3.5. A `create`/successful `update`
  always resets `locked` back to `false`.
- `acl` — optional per-object access control list, see §3.4. `null`/absent
  means visible and writable by everyone.

Objects only exist in memory/durable storage for the room's lifetime; they
are wiped whenever the host (re)connects (§2.2) and gone entirely once the
room closes (§2.7).

---

## 3. The object protocol: `<type>/<method>`

Opcodes matching `^[a-z]+/[a-z]+$` where the first segment is a known
`type` (`object`, `text`, `number`) are routed generically based on
`method`. `set` is accepted as an alias for `update` on the wire (so
`number/set` behaves exactly like `number/update`).

| Opcode pattern | Who may call it | Effect |
|---|---|---|
| `<type>/create` | host only | Create or fully overwrite an object, with full authority (bypasses lock/ACL) |
| `<type>/update` (alias `<type>/set`) | host, player | Host: same as create (full overwrite, bypasses lock/ACL). Player: apply only if not locked and ACL allows |
| `<type>/get` | host, player | Fetch current value, if readable |

Calling `<type>/method` for an unknown `type`, or a `method` your role
isn't permitted to call at all (e.g. a player calling `text/create`), is
silently a no-op — you still get the generic `{ opcode: "ok", result: {}, re: seq }`
ack, nothing is created/changed.

### 3.1 `<type>/create` (host only)

Request:

```json
{ "opcode": "number/create", "seq": 1, "params": { "key": "score", "val": 10, "acl": null } }
```

- `params.key` (string, required) — object identifier. If an object with
  this key already exists, it is fully replaced (its `version` counter
  keeps incrementing, it isn't reset to `0`; everything else about it — old
  `val`, old `acl` — is discarded).
- `params.val` — the new value.
- `params.acl` — optional ACL, see §3.4. Passing nothing/`null` makes the
  object open to everyone.
- Any other fields in `params` are stored only implicitly (they're not
  persisted on the object) but **are echoed back verbatim** in the
  broadcast result (see below) — useful for e.g. a `number` object's
  `min`/`max`/`increment` metadata that your game logic wants to travel
  alongside the value even though the server itself ignores it.

Effects:

1. Sender gets `{ opcode: "ok", result: {}, re: seq }`.
2. Every **player** whose ACL allows reading this object gets a broadcast
   (host never gets this notification for its own creates — there's only
   one host):

   ```json
   { "pc": 12, "opcode": "number", "result": { "key": "score", "val": 10, "acl": null, "version": 0 } }
   ```

   The broadcast `result` is simply `{ ...params, version: <new version> }`
   — i.e. everything you sent in the request, plus the authoritative
   `version`. (`acl`, if you sent one, is included here — the `get` result
   below is the one place it's stripped.)

### 3.2 `<type>/update` (host or player)

Request:

```json
{ "opcode": "number/update", "seq": 2, "params": { "key": "score", "val": 42 } }
```

Behavior differs by role:

- **Host**: identical to `create` — full overwrite, object is created if it
  doesn't exist yet, bypasses `locked`/ACL entirely, `version` still
  increments by exactly 1.
- **Player**: applied only if the object already exists, is not `locked`,
  and the object's ACL allows this connection to write. Otherwise it's
  silently ignored (no error) — the value is left completely unchanged. In
  **all** cases (applied or not) the sender still gets the generic `ok`
  ack; there is no way to distinguish "my update was rejected" from "my
  update succeeded" purely from the ack — a client SDK that needs
  confirmation should follow up with a `get`, or watch for the resulting
  broadcast (see below), to know whether it actually took effect.
- A successful update always clears `locked` back to `false`, regardless of
  who performed it.

Effects when the update actually changes the object (i.e. host always;
player only if allowed):

1. Sender gets `{ opcode: "ok", result: {}, re: seq }`.
2. Notification goes to **whichever side didn't originate the change**:
   - Player updated it → the host gets one broadcast.
   - Host updated it → every player whose ACL allows reading it gets one
     broadcast each.

   Broadcast shape is the same `{ ...params, version }` as for `create`.

### 3.3 `<type>/get` (host or player)

Request:

```json
{ "opcode": "number/get", "seq": 3, "params": { "key": "score" } }
```

- If the key doesn't exist, or the caller's ACL doesn't allow reading it:
  **no reply is sent at all** (not even an `ok`/error). Implement a timeout
  around `get` calls.
- Otherwise, the sender gets a direct reply (note: `opcode` here is the
  object's `kind`, not `"<type>/get"`):

  ```json
  { "pc": 8, "opcode": "number", "result": { "key": "score", "val": 42, "version": 1 }, "re": 3 }
  ```

  `result` is `{ ...params, val, version }` with `acl` stripped if present
  in the echoed params (any other fields you sent in the request's
  `params`, e.g. extra query metadata, come back verbatim alongside `val`
  and `version`).

### 3.4 Access control (ACL)

Passed as `params.acl` on `<type>/create` (ACL cannot be changed via
`update` — only a fresh `create`, or a privileged `update`, replaces it;
note a privileged `update` **does** accept and apply a new `acl` since it
behaves exactly like `create`).

Wire format — either a single rule:

```json
"acl": ["reject", "role:player"]
```

or a list of rules, evaluated in order, **last match wins**:

```json
"acl": [["accept", "*"], ["reject", "role:player"], ["accept", "id:3"]]
```

Each rule is `[effect, target]`:

- `effect`: `"accept"` or `"reject"`.
- `target`:
  - `"*"` — matches every connection.
  - `"role:<name>"` — matches any connection whose role is exactly
    `<name>` (e.g. `"role:host"`, `"role:player"` — role is a free-form
    string set at connect time, so a game-specific role system could use
    other values if the server exposed them, but the current
    implementation only ever assigns `"host"`/`"player"`).
  - `"id:<n>"` — matches the single connection with that exact connection
    id.

If no rule matches a given connection, or `acl` is `null`/omitted/empty,
that connection **is allowed** (default-open). The **host is always
exempt** from ACL and lock checks entirely (full read/write authority
regardless of ACL) — ACLs only ever restrict players.

Common patterns:

- Host-only (hidden from + unwritable by all players): `["reject", "role:player"]`
- Visible to everyone, writable by no one but the host: rely on `locked`
  (§3.5) instead, since ACL only gates read/write by identity, not by
  lock state.
- Visible/writable only by one specific player: `[["reject", "*"], ["accept", "id:3"]]`

### 3.5 `lock` (host or player)

```json
{ "opcode": "lock", "seq": 4, "params": { "key": "score" } }
```

Marks an object `locked: true` **if** the caller can currently write it
(host always can; a player only if not already locked and ACL allows).
Otherwise silently ignored. Always acked with generic `ok`.

While `locked`, players' `<type>/update` calls on that object are no-ops
(§3.2); the host can always write through a lock. Any successful update
clears the lock automatically.

Notification: if a **player** locks an object, the **host** gets a direct
message (not the generic broadcast shape):

```json
{ "pc": 9, "opcode": "lock", "result": { "key": "score", "from": 2 } }
```

If the **host** locks an object, no notification is sent to anyone (there's
only one host, and players aren't told).

There is no corresponding `unlock` opcode — locks clear only via a
successful `update`/`create` on that key.

---

## 4. Object types

All three share identical behavior today (framing/permissions come from
the shared `GameObject` base class); `type` only determines the opcode
prefix you use and the `kind`/broadcast `opcode` you receive:

| `type` (opcode prefix) | Broadcast/get `opcode` | Notes |
|---|---|---|
| `object` | `"object"` | Generic — put any JSON `val` here. |
| `text` | `"text"` | Semantically a string `val`; not actually type-checked. |
| `number` | `"number"` | Semantically a numeric `val`; not actually type-checked. |

A client SDK is free to expose distinct high-level types (`RoomObject`,
`RoomText`, `RoomNumber`) for ergonomics/documentation, but there's no
server-side validation difference to replicate.

---

## 5. Room-level (non-object) opcodes

| Opcode | Role | Request `params` | Behavior |
|---|---|---|---|
| `room/lock` | host only | `{}` | Sets the room `locked` flag. New player connections are rejected (`403` on the WS upgrade) while locked; doesn't affect already-connected players. No unlock opcode exists — a room only unlocks by the host reconnecting (§2.2, which resets the whole room anyway) or the room being torn down. |
| `room/exit` | host only | `{}` | Ends the room: every connected player is closed with code `1001` ("room closed by host"), the room is deactivated (its code becomes available for reuse — see §1.1), then the host itself is acked and closed with code `1000`. After this, `GET /api/v2/rooms/<code>` 404s. |
| `room/get-audience` | host only | `{}` | Direct reply `{ opcode: "room/get-audience", result: { connections: 0 }, re: seq }`. Always reports `0` in this implementation — there is no real spectator/audience feature; present for wire compatibility only. |
| `drop` | host only | `{ key }` | Deletes the object at `key` (no-op if it doesn't exist). No broadcast is sent to anyone — a client that needs peers to know an object is gone must communicate that itself (e.g. via `client/send`, or a convention like setting a sentinel value before drop). |
| `client/send` | player only | any JSON — passed through unmodified | Relays `params` verbatim to the host as `{ opcode: "client/send", result: <params> }` (no `re` on the host's copy — it's a broadcast to the host, not a reply to the host). The sending player still gets its own `ok` ack. There is no host → player equivalent opcode; if the host needs to push arbitrary data to a specific player, use a room object (with an ACL scoped to that player's `id:<n>`) instead. |

All five are role-gated the same way as everything else: calling one from
the wrong role is a no-op generic `ok` ack, not an error.

---

## 6. Disconnection semantics

- **Host disconnects** (any close reason/code): the room is deactivated
  immediately (its code becomes reusable — see §1.1) and every connected
  player is closed with code `1001`, reason `"host disconnected"`. There is
  no grace period/reconnect window — losing the host ends the room.
- **Player disconnects**: no side effects beyond removing that connection;
  the room keeps running, that player's id is not reused if they reconnect
  (they'll get a new, higher id and go through `client/welcome` again as if
  brand new — there is no session resume).
- **Host reconnects to the same room code** (i.e. a fresh `role=host`
  WS upgrade to a code that already has an active host or players): all
  existing players are forcibly closed (`1001`, "host reconnected, room
  reset") and the room's objects/lock state are wiped, but `appId`/
  `appTag`/`maxPlayers` are kept. Room code + those three fields are the
  only things that persist across a host "reconnect" — everything else is
  a clean slate.

A client SDK should treat every WebSocket close as terminal for that
connection (no automatic protocol-level resume exists to hook into) and
should surface `client/connected`'s absence-of-a-disconnect-event as a
known limitation if it wants presence tracking beyond the initial `here`
snapshot in `client/welcome`.

---

## 7. Suggested client SDK shape

A reasonable SDK built on this document would expose, at minimum:

- `createRoom({ appId, appTag, maxPlayers })` → `{ code, host }` (HTTP §1.1)
- `getRoomInfo(code)` → `{ locked, full, appId, appTag, ... }` (HTTP §1.3)
- `connectAsHost(code)` / `connectAsPlayer(code, name)` → a connection
  object that:
  - resolves once `client/welcome` arrives, exposing `id`, `entities`
    (hydrated into local object state), and `here` (initial presence)
  - exposes `createObject(type, key, val, acl?)`, `updateObject(type, key, val)`,
    `getObject(type, key, { timeoutMs })` (must time out — see §2.5/§3.3),
    `lock(key)`, `drop(key)` (host only), `send(params)` (player → host
    relay), `lockRoom()` / `exitRoom()` (host only)
  - emits events for incoming broadcasts keyed by object `kind`
    (`"object"`/`"text"`/`"number"`), `"lock"`, `"client/connected"`
    (host only), and `"client/send"` (host only)
  - tracks its own outgoing `seq` counter and matches replies via `re`
  - treats close events as terminal (no auto-reconnect/resume semantics to
    implement — see §6)

Since `pc` is per-connection and not otherwise meaningful to consumers, a
minimal SDK can safely ignore it beyond optionally logging/detecting gaps.
