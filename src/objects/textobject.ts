import { GameObject } from "../engine/gameobject";

/**
 * A room value that only ever holds text. Behaves identically to the base
 * "object" type - it exists as its own class purely so the type tag
 * ("text") and any future text-specific rules (e.g. profanity filtering)
 * have an obvious home.
 */
export class TextObject extends GameObject {
	static override kind: string = "text";
}
