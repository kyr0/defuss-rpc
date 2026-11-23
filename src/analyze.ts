/**
 * The static half of `defuss-rpc schema`: reads an API's TypeScript source and writes the schema `/rpc/schema` serves,
 * with each method's JSDoc, parameters and types.
 *
 * Why registration-aware instead of "every export": what a client may call is decided by the value passed to
 * `createRpcServer()` (or to the Vite / Astro integration's `api` option), not by `export`. An exported helper that is
 * never registered is not API, and a registered object's every function is - whatever its name. So the analysis
 * starts at those calls and follows the argument through imports, re-exports, `export default` and object literals
 * to the classes and objects behind each namespace, then applies the server's exposure rule (src/server.ts
 * exposedMethods): a class's own prototype methods, a module's own function properties, nothing inherited.
 *
 * Why ts-morph: it carries its own TypeScript compiler (VERIFIED: ts-morph 28.0.0 bundles TypeScript 6.0.2), so the
 * tool keeps working in a project on TypeScript 7, whose package no longer has the JavaScript Compiler API, and the
 * type checker resolves aliases, inferred return types and JSDoc. A value the checker cannot follow (a function call,
 * a dynamic key) becomes a diagnostic, never a guessed method.
 */
import { Node, SyntaxKind, ts, type JSDocableNode, type Project, type SourceFile, type Type } from "ts-morph";
import type { RpcApiSchema, RpcJsonSchema, RpcMethodDescriptor, RpcParamDoc, RpcSchemaEntry, RpcValueDoc } from "./types.d.js";

/** One finding of the analysis: the file and line it is about, and what happened there. */
export interface RpcDiagnostic {
	level: "error" | "warning";
	file: string;
	line: number;
	message: string;
}

/** What {@link analyzeRpcApi} found: the documented schema, and every place it could not follow or had to warn about. */
export interface RpcAnalysis {
	schema: RpcApiSchema;
	diagnostics: RpcDiagnostic[];
}

/** The modules whose `createRpcServer` (or deprecated `registerGlobalRpcApi`) registers an API, and the integrations whose `api` option does. */
const SERVER_MODULE = /^defuss-rpc(\/server(\.js)?)?$/;
const INTEGRATION_MODULE = /^defuss-rpc-(vite|astro)$/;

type FunctionLike =
	| import("ts-morph").MethodDeclaration
	| import("ts-morph").FunctionDeclaration
	| import("ts-morph").FunctionExpression
	| import("ts-morph").ArrowFunction;

/** A namespace as the analysis resolved it: a class or an object literal, under the name the client calls. */
type Namespace =
	| { kind: "class"; name: string; node: import("ts-morph").ClassDeclaration | import("ts-morph").ClassExpression }
	| { kind: "module"; name: string; node: import("ts-morph").ObjectLiteralExpression };

/** True when the given files register an API with defuss-rpc: the cheap filter before any type is checked. */
export function usesDefussRpc(file: SourceFile): boolean {
	return file
		.getImportDeclarations()
		.some((d) => SERVER_MODULE.test(d.getModuleSpecifierValue()) || INTEGRATION_MODULE.test(d.getModuleSpecifierValue()));
}

/**
 * Analyzes the given source files: every `createRpcServer(api)` and `defussRpc({ api })` call in them, the namespaces
 * the argument holds, and each exposed method's documentation. Files that import nothing from defuss-rpc are skipped.
 * Two registrations of the same namespace name keep the first: the schema documents namespaces by name, so servers
 * that reuse a name in one project share the documentation of the first.
 *
 * @param project - a ts-morph project that holds the files and resolves their imports
 * @param files - the files to search for registrations
 * @returns the documented schema, in registration order, and the diagnostics
 */
export function analyzeRpcApi(project: Project, files: readonly SourceFile[]): RpcAnalysis {
	const diagnostics: RpcDiagnostic[] = [];
	const reported = new Set<string>();
	// one diagnostic per place and message: a value registered by several servers is reported once
	const report = (level: RpcDiagnostic["level"], node: Node, message: string) => {
		const diagnostic = { level, file: relative(project, node.getSourceFile()), line: node.getStartLineNumber(), message };
		const key = JSON.stringify(diagnostic);
		if (reported.has(key)) return;
		reported.add(key);
		diagnostics.push(diagnostic);
	};
	const namespaces = new Map<string, Namespace>();

	for (const file of files) {
		if (!usesDefussRpc(file)) continue;
		for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
			const registered = registrationArgument(call);
			if (!registered) continue;
			for (const [name, value] of objectMembers(registered, report)) {
				if (namespaces.has(name)) continue;
				const ns = namespaceOf(name, value);
				if (ns) namespaces.set(name, ns);
				else report("error", value, `namespace ${name}: not a class or an object literal the analysis can follow`);
			}
		}
	}

	const schema: RpcApiSchema = [];
	for (const ns of namespaces.values()) {
		const description = docText(ns.node.getParentIfKind(SyntaxKind.VariableDeclaration)?.getVariableStatement() ?? ns.node);
		const methods: Record<string, RpcMethodDescriptor> = {};
		for (const [name, fn, docNode] of exposed(ns, report)) methods[name] = describeMethod(fn, docNode);
		const entry: RpcSchemaEntry =
			ns.kind === "class"
				? { kind: "class", className: ns.name, ...(description ? { description } : {}), methods, properties: {} }
				: { kind: "module", moduleName: ns.name, ...(description ? { description } : {}), methods };
		schema.push(entry);
	}
	return { schema, diagnostics };

	/** The API value a call registers, or undefined when the call is no registration. */
	function registrationArgument(call: import("ts-morph").CallExpression): Node | undefined {
		const callee = call.getExpression();
		const arg = call.getArguments()[0];
		if (!arg) return undefined;
		if (importedFrom(callee, "createRpcServer", SERVER_MODULE) || importedFrom(callee, "registerGlobalRpcApi", SERVER_MODULE)) return arg;
		if (importedFrom(callee, "default", INTEGRATION_MODULE) || importedFrom(callee, "defussRpc", INTEGRATION_MODULE)) {
			const options = resolveValue(arg);
			if (!Node.isObjectLiteralExpression(options)) return undefined;
			const api = options.getProperty("api");
			if (Node.isPropertyAssignment(api)) return api.getInitializerOrThrow();
			if (Node.isShorthandPropertyAssignment(api)) return api.getNameNode();
		}
		return undefined;
	}

	/** The members of the object a node evaluates to, name → value node; spreads are flattened in order. */
	function objectMembers(node: Node, warn: typeof report): [string, Node][] {
		const value = resolveValue(node);
		if (!Node.isObjectLiteralExpression(value)) {
			warn("error", node, "the registered API is not an object literal the analysis can follow");
			return [];
		}
		const members: [string, Node][] = [];
		for (const prop of value.getProperties()) {
			if (Node.isSpreadAssignment(prop)) members.push(...objectMembers(prop.getExpression(), warn));
			else if (Node.isShorthandPropertyAssignment(prop)) members.push([prop.getName(), prop.getNameNode()]);
			else if (Node.isPropertyAssignment(prop)) {
				const key = prop.getNameNode();
				if (Node.isComputedPropertyName(key)) warn("warning", prop, "a computed namespace name is left out");
				else members.push([prop.getName().replace(/^["']|["']$/g, ""), prop.getInitializerOrThrow()]);
			} else warn("warning", prop, `${prop.getKindName()} in the registered API is left out`);
		}
		return members;
	}

	function namespaceOf(name: string, value: Node): Namespace | undefined {
		const node = resolveValue(value);
		if (Node.isClassDeclaration(node) || Node.isClassExpression(node)) return { kind: "class", name, node };
		if (Node.isObjectLiteralExpression(node)) return { kind: "module", name, node };
		return undefined;
	}

	/**
	 * The exposed methods of a namespace, after the server's rule: [name, function, the node its JSDoc sits on].
	 * A class: its own non-static methods (no constructor, accessor, field or `#private` member). A module: its
	 * properties whose value is a function (methods, arrow functions, function expressions, references to them).
	 */
	function exposed(ns: Namespace, warn: typeof report): [string, FunctionLike, Node][] {
		const list: [string, FunctionLike, Node][] = [];
		if (ns.kind === "class") {
			for (const member of ns.node.getMethods()) {
				// an overload signature has no body; its implementation is the one method
				if (member.isStatic() || member.isOverload() || Node.isPrivateIdentifier(member.getNameNode())) continue;
				const name = member.getName();
				if (name === "constructor") continue;
				if (member.hasModifier(SyntaxKind.PrivateKeyword) || member.hasModifier(SyntaxKind.ProtectedKeyword))
					warn("warning", member, `${ns.name}.${name} is ${member.hasModifier(SyntaxKind.PrivateKeyword) ? "private" : "protected"} in TypeScript but callable over RPC - name it #${name} to hide it`);
				list.push([name, member, member]);
			}
			return list;
		}
		for (const prop of ns.node.getProperties()) {
			if (Node.isMethodDeclaration(prop)) list.push([prop.getName(), prop, prop]);
			else if (Node.isPropertyAssignment(prop) || Node.isShorthandPropertyAssignment(prop)) {
				const target = resolveValue(Node.isPropertyAssignment(prop) ? prop.getInitializerOrThrow() : prop.getNameNode());
				const fn = Node.isFunctionDeclaration(target) || Node.isFunctionExpression(target) || Node.isArrowFunction(target) ? target : undefined;
				if (fn) list.push([prop.getName().replace(/^["']|["']$/g, ""), fn, Node.isFunctionDeclaration(target) ? target : prop]);
				else if (prop.getType().getCallSignatures().length)
					warn("warning", prop, `${ns.name}.${prop.getName()} is a function the analysis cannot follow to its declaration - left out`);
			} else if (Node.isSpreadAssignment(prop)) {
				warn("warning", prop, `a spread inside namespace ${ns.name} is left out`);
			}
		}
		return list;
	}
}

/** The path of a file relative to the project's working directory. */
function relative(project: Project, file: SourceFile): string {
	const cwd = project.getFileSystem().getCurrentDirectory().replace(/\/$/, "");
	const path = file.getFilePath();
	return path.startsWith(cwd + "/") ? path.slice(cwd.length + 1) : path;
}

/** True when `node` names `exported` of a module matching `module` (a named, renamed or namespace import). */
function importedFrom(node: Node, exported: string, module: RegExp): boolean {
	const fromImport = (decl: Node | undefined): boolean => {
		const declaration = decl?.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
		return !!declaration && module.test(declaration.getModuleSpecifierValue());
	};
	if (Node.isPropertyAccessExpression(node)) {
		if (node.getName() !== exported) return false;
		const target = node.getExpression().getSymbol()?.getDeclarations()[0];
		return Node.isNamespaceImport(target) && fromImport(target);
	}
	const decl = node.getSymbol()?.getDeclarations()[0];
	if (Node.isImportSpecifier(decl)) return decl.getName() === exported && fromImport(decl);
	if (Node.isImportClause(decl)) return exported === "default" && fromImport(decl);
	return false;
}

/**
 * The node a value expression stands for: through parentheses, `as` / `satisfies` / `!`, identifiers (imports,
 * re-exports, `export default`, `const x = ...`) to a class, a function or an object literal. Anything else is
 * returned as it is, for the caller to report.
 */
function resolveValue(node: Node, depth = 0): Node {
	if (depth > 32) return node;
	if (Node.isParenthesizedExpression(node) || Node.isAsExpression(node) || Node.isSatisfiesExpression(node) || Node.isNonNullExpression(node))
		return resolveValue(node.getExpression(), depth + 1);
	if (Node.isIdentifier(node)) {
		// the name of a shorthand property `{ MathApi }` stands for the variable it reads, not for the property
		const shorthand = node.getParentIfKind(SyntaxKind.ShorthandPropertyAssignment);
		let symbol =
			shorthand?.getNameNode() === node
				? node.getProject().getTypeChecker().getShorthandAssignmentValueSymbol(shorthand)
				: node.getSymbol();
		if (symbol?.isAlias()) symbol = symbol.getAliasedSymbol() ?? symbol;
		const decl = symbol?.getValueDeclaration() ?? symbol?.getDeclarations()[0];
		if (!decl) return node;
		if (Node.isVariableDeclaration(decl)) {
			const init = decl.getInitializer();
			return init ? resolveValue(init, depth + 1) : decl;
		}
		if (Node.isExportAssignment(decl)) return resolveValue(decl.getExpression(), depth + 1);
		return decl;
	}
	return node;
}

/** The JSDoc text of a node (its last JSDoc block), without tags. */
function docText(node: Node): string | undefined {
	const docs = (Node.isJSDocable(node) ? (node as unknown as JSDocableNode).getJsDocs() : []) as import("ts-morph").JSDoc[];
	const text = docs.at(-1)?.getDescription().trim();
	return text || undefined;
}

/** The JSDoc tags of a node's last JSDoc block. */
function docTags(node: Node): import("ts-morph").JSDocTag[] {
	const docs = (Node.isJSDocable(node) ? (node as unknown as JSDocableNode).getJsDocs() : []) as import("ts-morph").JSDoc[];
	return docs.at(-1)?.getTags() ?? [];
}

const tagText = (tag: import("ts-morph").JSDocTag): string => {
	const comment = tag.getCommentText()?.trim() ?? "";
	return comment.replace(/^-\s*/, "");
};

/** One method's descriptor: the runtime flags the server would compute, then everything its source documents. */
function describeMethod(fn: FunctionLike, docNode: Node): RpcMethodDescriptor {
	const generator = !Node.isArrowFunction(fn) && fn.isGenerator();
	const descriptor: RpcMethodDescriptor = { async: fn.isAsync(), generator };
	const description = docText(docNode);
	if (description) descriptor.description = description;

	const tags = docTags(docNode);
	const paramDocs = new Map<string, string>();
	for (const tag of tags)
		if (Node.isJSDocParameterTag(tag)) paramDocs.set(tag.getName(), tagText(tag));

	const params: RpcParamDoc[] = fn.getParameters().map((p) => {
		const name = p.getName();
		const param: RpcParamDoc = { name, ...valueDoc(p.getType(), fn) };
		if (p.isOptional() || p.hasInitializer()) param.optional = true;
		if (p.isRestParameter()) param.rest = true;
		const doc = paramDocs.get(name);
		if (doc) param.description = doc;
		return param;
	});
	if (params.length) descriptor.params = params;

	const returnType = fn.getReturnType();
	const tagOf = (...names: string[]) => tags.find((t) => names.includes(t.getTagName()));
	if (generator) {
		const [yieldType, resultType] = returnType.getTypeArguments();
		if (yieldType) descriptor.yields = withDoc(valueDoc(yieldType, fn), tagOf("yields", "yield"));
		if (resultType && !isVoid(resultType)) descriptor.returns = withDoc(valueDoc(resultType, fn), tagOf("returns", "return"));
	} else {
		const awaited = awaitedType(returnType);
		if (!isVoid(awaited)) descriptor.returns = withDoc(valueDoc(awaited, fn), tagOf("returns", "return"));
	}
	const deprecated = tagOf("deprecated");
	if (deprecated) descriptor.deprecated = tagText(deprecated) || true;
	const throws = tags.filter((t) => t.getTagName() === "throws" || t.getTagName() === "exception").map(tagText).filter(Boolean);
	if (throws.length) descriptor.throws = throws;
	const examples = tags.filter((t) => t.getTagName() === "example").map((t) => t.getCommentText()?.replace(/^\s*\n/, "").trimEnd() ?? "").filter(Boolean);
	if (examples.length) descriptor.examples = examples;
	return descriptor;
}

const withDoc = (value: RpcValueDoc, tag: import("ts-morph").JSDocTag | undefined): RpcValueDoc => {
	const text = tag ? tagText(tag) : "";
	return text ? { ...value, description: text } : value;
};

const isVoid = (type: Type) => type.isUndefined() || (type.getFlags() & ts.TypeFlags.Void) !== 0;

/** The type a `Promise` (or any awaitable) resolves to; other types as they are. */
function awaitedType(type: Type): Type {
	const symbol = type.getSymbol() ?? type.getAliasSymbol();
	if (symbol?.getName() === "Promise" || symbol?.getName() === "PromiseLike") {
		const [inner] = type.getTypeArguments();
		if (inner) return awaitedType(inner);
	}
	return type;
}

/** A value's TypeScript text and JSON Schema, printed relative to the function (no `import("...")` prefixes). */
function valueDoc(type: Type, context: Node): RpcValueDoc {
	return {
		type: type.getText(context, ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope | ts.TypeFormatFlags.NoTruncation),
		schema: jsonSchema(type, context, new Set()),
	};
}

const BINARY = new Set([
	"Uint8Array",
	"Uint8ClampedArray",
	"Int8Array",
	"Uint16Array",
	"Int16Array",
	"Uint32Array",
	"Int32Array",
	"Float32Array",
	"Float64Array",
	"BigInt64Array",
	"BigUint64Array",
	"ArrayBuffer",
]);

/**
 * A JSON Schema (draft 2020-12) for a TypeScript type, in the convention of defuss-db's analyzeSchema: values DSON
 * carries beyond JSON keep a JSON type and name theirs in `x-dson` (date, bigint, binary, map, set). Lenient where the
 * defuss-mcp contract compiler refuses: documentation describes every type, so a type without a JSON shape (a function,
 * a recursive reference, `any`) becomes `{}` with a `$comment` that says why.
 */
function jsonSchema(type: Type, context: Node, seen: Set<Type>): RpcJsonSchema {
	if (type.isAny() || type.isUnknown()) return {};
	if (type.isString()) return { type: "string" };
	if (type.isNumber()) return { type: "number" };
	if (type.isBoolean()) return { type: "boolean" };
	if ((type.getFlags() & ts.TypeFlags.BigInt) !== 0) return { type: "integer", "x-dson": "bigint" };
	if (type.isNull()) return { type: "null" };
	if (type.isUndefined() || isVoid(type)) return { $comment: "undefined" };
	if (type.isStringLiteral() || type.isNumberLiteral()) return { const: type.getLiteralValue() };
	if (type.isBooleanLiteral()) return { const: type.getText() === "true" };
	if ((type.getFlags() & ts.TypeFlags.BigIntLiteral) !== 0) return { type: "integer", "x-dson": "bigint", const: type.getText().replace(/n$/, "") };
	if (type.isUnion()) {
		// undefined is an optional value's absence; null goes last, as a reader writes `User | null`
		const members = type
			.getUnionTypes()
			.filter((t) => !t.isUndefined())
			.sort((a, b) => Number(a.isNull()) - Number(b.isNull()));
		// a boolean is the union true | false
		if (members.length === 2 && members.every((t) => t.isBooleanLiteral())) return { type: "boolean" };
		if (members.length && members.every((t) => t.isStringLiteral() || t.isNumberLiteral()))
			return { enum: members.map((t) => t.getLiteralValue()) };
		const booleans = members.filter((t) => t.isBooleanLiteral());
		const rest = booleans.length === 2 ? members.filter((t) => !t.isBooleanLiteral()) : members;
		const anyOf = rest.map((t) => jsonSchema(t, context, seen));
		if (booleans.length === 2) anyOf.push({ type: "boolean" });
		return anyOf.length === 1 ? anyOf[0]! : { anyOf };
	}
	if (type.isIntersection()) return { allOf: type.getIntersectionTypes().map((t) => jsonSchema(t, context, seen)) };

	const name = (type.getSymbol() ?? type.getAliasSymbol())?.getName();
	if (name === "Date") return { type: "string", format: "date-time", "x-dson": "date" };
	if (name && BINARY.has(name)) return { type: "string", contentEncoding: "base64", "x-dson": "binary" };
	if (name === "Set" || name === "ReadonlySet") {
		const [item] = type.getTypeArguments();
		return { type: "array", uniqueItems: true, "x-dson": "set", ...(item ? { items: jsonSchema(item, context, seen) } : {}) };
	}
	if (name === "Map" || name === "ReadonlyMap") {
		const [, value] = type.getTypeArguments();
		return { type: "object", "x-dson": "map", ...(value ? { additionalProperties: jsonSchema(value, context, seen) } : {}) };
	}
	if (type.isTuple())
		return { type: "array", prefixItems: type.getTupleElements().map((t) => jsonSchema(t, context, seen)), items: false };
	if (type.isArray()) {
		const item = type.getArrayElementType();
		return { type: "array", ...(item ? { items: jsonSchema(item, context, seen) } : {}) };
	}
	if (type.getCallSignatures().length) return { $comment: "a function - not serializable" };
	if (type.isObject()) {
		if (seen.has(type)) return { $comment: `recursive: ${type.getText(context)}` };
		const inner = new Set(seen).add(type);
		const properties: Record<string, RpcJsonSchema> = {};
		const required: string[] = [];
		for (const prop of type.getProperties()) {
			const decl = prop.getValueDeclaration() ?? prop.getDeclarations()[0];
			const propType = decl ? prop.getTypeAtLocation(decl) : prop.getDeclaredType();
			const schema = jsonSchema(propType, context, inner);
			const doc = decl ? docText(decl) : undefined;
			properties[prop.getName()] = doc ? { ...schema, description: doc } : schema;
			if (!prop.isOptional()) required.push(prop.getName());
		}
		const index = type.getStringIndexType() ?? type.getNumberIndexType();
		return {
			type: "object",
			...(Object.keys(properties).length ? { properties } : {}),
			...(required.length ? { required } : {}),
			...(index ? { additionalProperties: jsonSchema(index, context, inner) } : {}),
		};
	}
	return { $comment: `no JSON shape: ${type.getText(context)}` };
}

/** The name the client calls a namespace by. */
const namespaceName = (entry: RpcSchemaEntry) => (entry.kind === "class" ? entry.className : entry.moduleName);

/**
 * Checks the static schema against what a running server serves at `/rpc/schema`, which is cheap and authoritative
 * for what is callable: the result keeps the server's namespaces and methods, in its order, with their async /
 * generator flags, and the source's documentation where the source has the method. Every difference is a warning -
 * a method the source has and the server does not (left out), one the server serves and the analysis did not find
 * (kept, undocumented), a flag that differs (the server's wins).
 *
 * @param analyzed - the schema {@link analyzeRpcApi} found
 * @param served - the server's `/rpc/schema` answer
 * @param endpoint - the server's URL, named in the diagnostics
 * @returns the reconciled schema and the differences
 */
export function reconcileWithServer(analyzed: RpcApiSchema, served: RpcApiSchema, endpoint: string): RpcAnalysis {
	const diagnostics: RpcDiagnostic[] = [];
	const warn = (message: string) => diagnostics.push({ level: "warning", file: endpoint, line: 0, message });
	const found = new Map(analyzed.map((entry) => [namespaceName(entry), entry]));
	const schema: RpcApiSchema = [];
	for (const live of served) {
		const name = namespaceName(live);
		const source = found.get(name);
		found.delete(name);
		if (!source) {
			warn(`namespace ${name} is served but not found in the source - kept without documentation`);
			schema.push(live);
			continue;
		}
		const methods: Record<string, RpcMethodDescriptor> = {};
		for (const [method, flags] of Object.entries(live.methods)) {
			const doc = source.methods[method];
			if (!doc) warn(`${name}.${method} is served but not found in the source - kept without documentation`);
			else if (doc.async !== flags.async || doc.generator !== flags.generator)
				warn(`${name}.${method}: the source says async=${doc.async} generator=${doc.generator}, the server ${flags.async} / ${flags.generator} - the server's flags are kept`);
			methods[method] = { ...doc, async: flags.async, generator: flags.generator };
		}
		for (const method of Object.keys(source.methods))
			if (!(method in live.methods)) warn(`${name}.${method} is in the source but not served - left out`);
		const description = source.description ? { description: source.description } : {};
		schema.push({ ...live, ...description, methods });
	}
	for (const name of found.keys()) warn(`namespace ${name} is in the source but not served - left out`);
	return { schema, diagnostics };
}
