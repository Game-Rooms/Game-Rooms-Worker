import type { Connection } from "./connection";

/** Whether a rule grants or revokes access when it matches. */
export type AclEffect = "accept" | "reject";

/** The wire representation of one ACL rule: `[effect, target]`. */
export type AclRuleTuple = [AclEffect, string];

/** One parsed ACL rule. */
export interface AclRule {
	effect: AclEffect;
	target: string;
}

/**
 * A GameObject's access control list: an ordered set of rules, where target
 * is one of:
 *
 *   "*"          - everyone
 *   "role:<x>"   - any connection whose `role` is exactly "<x>" (e.g.
 *                  "role:host", "role:player", or any custom role a room
 *                  assigns - the ACL system has no built-in notion of roles,
 *                  it just compares strings)
 *   "id:<n>"     - the connection with that exact id
 *
 * Rules are evaluated in order and the *last* matching rule wins, e.g.
 * [["accept", "*"], ["reject", "role:player"]] means "visible to everyone
 * except players" (i.e. host-only). If no rule matches a given connection,
 * access defaults to allowed - an object with no ACL (or whose ACL doesn't
 * mention the requester) is visible/writable by everyone, same as having no
 * ACL at all.
 *
 * On the wire an ACL arrives as either a single ["accept"|"reject", target]
 * pair (shorthand for one rule) or a full array of such pairs.
 */
export class Acl {
	rules: AclRule[];

	constructor(rules: AclRule[]) {
		this.rules = rules;
	}

	/** Parse the wire format sent in a `create` request's `acl` param. */
	static parse(raw: unknown): Acl | null {
		if (!Array.isArray(raw) || raw.length === 0) return null;

		// Accept either a single ["accept"|"reject", target] pair, or an array of such pairs.
		const isShorthand = typeof raw[0] === "string";
		const entries: unknown[] = isShorthand ? [raw] : raw;

		const rules: AclRule[] = entries
			.filter((entry): entry is AclRuleTuple => Array.isArray(entry) && (entry[0] === "accept" || entry[0] === "reject") && Boolean(entry[1]))
			.map(([effect, target]) => ({ effect, target }));

		return rules.length ? new Acl(rules) : null;
	}

	/** Reconstruct from the plain array previously produced by toJSON(). */
	static fromJSON(json: AclRuleTuple[] | null | undefined): Acl | null {
		if (!json || json.length === 0) return null;
		return new Acl(json.map(([effect, target]) => ({ effect, target })));
	}

	toJSON(): AclRuleTuple[] {
		return this.rules.map((rule) => [rule.effect, rule.target]);
	}

	/** Whether a single rule's `target` describes `connection`. */
	private targetMatches(target: string, connection: Connection): boolean {
		if (target === "*") 
			return true;
		if (target.startsWith("role:")) 
			return connection.role === target.slice("role:".length);
		if (target.startsWith("id:")) 
			return String(connection.id) === target.slice("id:".length);
		return false;
	}

	/** Whether `connection` is allowed access under this ACL (last matching rule wins). */
	allows(connection: Connection): boolean {
		let allowed = true; // default-open when nothing matches

		for (const rule of this.rules) {
			if (this.targetMatches(rule.target, connection)) {
				allowed = rule.effect === "accept";
			}
		}

		return allowed;
	}
}
