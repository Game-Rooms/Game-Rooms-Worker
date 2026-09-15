import { isKnownObjectType } from "../objects/objectTypes";

/**
 * The ecast object protocol's opcodes all follow the same "<type>/<method>"
 * schema, e.g. "number/create", "text/update", "object/get". `<type>` picks
 * the GameObject subclass (see objectTypes.ts); `<method>` picks which of
 * its methods runs (see GameObject.methodRoles + routers/objectRouter.ts).
 */
const OPCODE_PATTERN = /^([a-z]+)\/([a-z]+)$/;

/** "set" is just an alias for "update" on the wire. */
const METHOD_ALIASES: Record<string, string> = { set: "update" };

/** A parsed `<type>/<method>` opcode, e.g. "number/create" -> { type: "number", method: "create" }. */
export interface ParsedObjectOpcode {
	type: string;
	method: string;
}

/**
 * Split an opcode like "number/create" into { type: "number", method: "create" }.
 * Returns null for opcodes that aren't part of the `<type>/<method>` object
 * protocol (e.g. "lock", "room/exit", "client/send") or that name an unknown
 * type/method.
 */
export function parseObjectOpcode(opcode: string): ParsedObjectOpcode | null {
	const match = OPCODE_PATTERN.exec(opcode);
	if (!match) 
		return null;

	const [, type, rawMethod] = match;
	if (!isKnownObjectType(type)) 
		return null;

	const method = METHOD_ALIASES[rawMethod] ?? rawMethod;
	return { type, method };
}
