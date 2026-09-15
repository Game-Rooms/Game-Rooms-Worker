import { GameObject, type GameObjectJSON } from "../engine/gameobject";
import { TextObject } from "./textobject";
import { NumberObject } from "./numberobject";

/** `<type>` (from the "<type>/<method>" opcode schema) -> concrete GameObject subclass. */
const OBJECT_TYPES: Record<string, typeof GameObject> = {
	object: GameObject,
	text: TextObject,
	number: NumberObject,
};

export function isKnownObjectType(type: string): boolean {
	return Object.prototype.hasOwnProperty.call(OBJECT_TYPES, type);
}

/** The concrete GameObject subclass for a given `<type>`, or null if unknown. */
export function getObjectClass(type: string): typeof GameObject | null {
	return OBJECT_TYPES[type] ?? null;
}

export function createGameObject(type: string, key: string): GameObject {
	const ObjectClass = OBJECT_TYPES[type];
	if (!ObjectClass) 
		throw new Error(`unknown room object type "${type}"`);

	return new ObjectClass(key);
}

export function gameObjectFromJSON(json: GameObjectJSON): GameObject {
	const ObjectClass = OBJECT_TYPES[json.type];
	if (!ObjectClass) 
		throw new Error(`unknown room object type "${json.type}"`);

	return ObjectClass.fromJSON(json);
}
