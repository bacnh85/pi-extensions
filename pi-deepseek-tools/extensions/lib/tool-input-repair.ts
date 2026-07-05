import { Compile } from "typebox/compile";

export type RepairKind = "path-markdown-autolink" | "optional-null" | "json-string" | "empty-object-array" | "bare-string-array";

export type RepairResult = {
	args: unknown;
	repaired: boolean;
	repairs: RepairKind[];
};

const PATH_FIELD_NAMES = new Set(["path", "filePath", "absolutePath", "relativePath", "relative_path"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function compileCheck(schema: unknown, args: unknown): boolean {
	return Compile(schema as never).Check(args);
}

function validationErrors(schema: unknown, args: unknown): Array<{ instancePath?: string; path?: string; keyword?: string }> {
	return Array.from(Compile(schema as never).Errors(args)) as Array<{ instancePath?: string; path?: string; keyword?: string }>;
}

function errorPath(error: { instancePath?: string; path?: string }): string[] {
	const path = error.instancePath ?? error.path ?? "";
	return path.replace(/^\//, "").split("/").filter(Boolean).map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function schemaTypes(schema: unknown): string[] {
	if (!isRecord(schema)) return [];
	if (typeof schema.type === "string") return [schema.type];
	if (Array.isArray(schema.type)) return schema.type.filter((type): type is string => typeof type === "string");
	if (Array.isArray(schema.anyOf)) return schema.anyOf.flatMap(schemaTypes);
	if (Array.isArray(schema.oneOf)) return schema.oneOf.flatMap(schemaTypes);
	return [];
}

function schemaAtPath(schema: unknown, path: readonly string[]): unknown {
	let current = schema;
	for (const part of path) {
		if (!isRecord(current)) return undefined;
		const types = schemaTypes(current);
		if (types.includes("object") && isRecord(current.properties)) {
			current = current.properties[part];
			continue;
		}
		if (types.includes("array")) {
			current = current.items;
			continue;
		}
		return undefined;
	}
	return current;
}

function parentAtPath(value: unknown, path: readonly string[]): { parent: unknown; key: string } | undefined {
	if (path.length === 0) return undefined;
	let parent = value;
	for (const part of path.slice(0, -1)) {
		if (Array.isArray(parent)) parent = parent[Number(part)];
		else if (isRecord(parent)) parent = parent[part];
		else return undefined;
	}
	return { parent, key: path[path.length - 1] };
}

function getAtPath(value: unknown, path: readonly string[]): unknown {
	let current = value;
	for (const part of path) {
		if (Array.isArray(current)) current = current[Number(part)];
		else if (isRecord(current)) current = current[part];
		else return undefined;
	}
	return current;
}

function setAtPath(value: unknown, path: readonly string[], next: unknown): boolean {
	if (path.length === 0) return false;
	const target = parentAtPath(value, path);
	if (!target) return false;
	if (Array.isArray(target.parent)) target.parent[Number(target.key)] = next;
	else if (isRecord(target.parent)) target.parent[target.key] = next;
	else return false;
	return true;
}

function deleteAtPath(value: unknown, path: readonly string[]): boolean {
	const target = parentAtPath(value, path);
	if (!target) return false;
	if (Array.isArray(target.parent)) target.parent.splice(Number(target.key), 1);
	else if (isRecord(target.parent)) delete target.parent[target.key];
	else return false;
	return true;
}

function isOptionalProperty(rootSchema: unknown, path: readonly string[]): boolean {
	if (path.length === 0) return false;
	const parentSchema = schemaAtPath(rootSchema, path.slice(0, -1));
	if (!isRecord(parentSchema) || !isRecord(parentSchema.properties)) return false;
	const required = Array.isArray(parentSchema.required) ? parentSchema.required : [];
	return Object.hasOwn(parentSchema.properties, path[path.length - 1]) && !required.includes(path[path.length - 1]);
}

function expects(schema: unknown, type: "array" | "object"): boolean {
	return schemaTypes(schema).includes(type);
}

function tryRepairPath(rootSchema: unknown, args: unknown, path: readonly string[]): RepairKind | undefined {
	const current = getAtPath(args, path);
	const targetSchema = schemaAtPath(rootSchema, path);

	if (current === null && isOptionalProperty(rootSchema, path) && deleteAtPath(args, path)) return "optional-null";

	if (typeof current === "string" && (expects(targetSchema, "array") || expects(targetSchema, "object"))) {
		try {
			const parsed = JSON.parse(current);
			if ((expects(targetSchema, "array") && Array.isArray(parsed)) || (expects(targetSchema, "object") && isRecord(parsed))) {
				if (setAtPath(args, path, parsed)) return "json-string";
			}
		} catch {
			// Not JSON; maybe a bare array item below.
		}
	}

	if (expects(targetSchema, "array") && isRecord(current) && Object.keys(current).length === 0) {
		if (setAtPath(args, path, [])) return "empty-object-array";
	}

	if (expects(targetSchema, "array") && typeof current === "string") {
		if (setAtPath(args, path, [current])) return "bare-string-array";
	}

	return undefined;
}

function normalizedLinkTarget(value: string): string {
	return value.replace(/^https?:\/\//i, "").replace(/\s+/g, "").replace(/^\/+/, "");
}

export function unwrapDegenerateMarkdownAutolink(value: string): string {
	return value.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)]+)\)/g, (match, text: string, url: string) => {
		const normalizedText = text.replace(/\s+/g, "");
		const normalizedUrl = normalizedLinkTarget(url);
		return normalizedUrl === normalizedText || normalizedUrl.endsWith(`/${normalizedText}`) ? text : match;
	});
}

function cleanPathFields(value: unknown): { value: unknown; changed: boolean } {
	let changed = false;
	const visit = (current: unknown, key?: string): unknown => {
		if (typeof current === "string" && key && PATH_FIELD_NAMES.has(key)) {
			const next = unwrapDegenerateMarkdownAutolink(current);
			changed ||= next !== current;
			return next;
		}
		if (Array.isArray(current)) return current.map((item) => visit(item));
		if (!isRecord(current)) return current;
		const next: Record<string, unknown> = {};
		for (const [entryKey, entryValue] of Object.entries(current)) next[entryKey] = visit(entryValue, entryKey);
		return next;
	};
	const nextValue = visit(value);
	return { value: changed ? nextValue : value, changed };
}

export function repairDeepSeekToolArguments(_toolName: string, schema: unknown, args: unknown): RepairResult {
	const pathCleaned = cleanPathFields(args);
	if (compileCheck(schema, pathCleaned.value)) {
		return { args: pathCleaned.value, repaired: pathCleaned.changed, repairs: pathCleaned.changed ? ["path-markdown-autolink"] : [] };
	}

	const candidate = clone(pathCleaned.value);
	const repairs: RepairKind[] = pathCleaned.changed ? ["path-markdown-autolink"] : [];
	for (const error of validationErrors(schema, candidate)) {
		const repaired = tryRepairPath(schema, candidate, errorPath(error));
		if (repaired) repairs.push(repaired);
	}

	return { args: repairs.length > 0 ? candidate : args, repaired: repairs.length > 0, repairs };
}
