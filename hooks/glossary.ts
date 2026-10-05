// Core glossary logic, free of the plugin engine (`$`). All IO is injected via
// `GlossaryIO` so register.tsx can back it with `$.fs`, `$.http`, `$.process`,
// and tests can back it with in-memory fakes.

export type GlossaryEntry = {
	term: string;
	definition: string;
	aliases?: string[];
	pattern?: string;
	flags?: string;
	enabled?: boolean;
	source?: string;
	/**
	 * Whether `{{...}}` placeholders in the definition may run shell commands.
	 * Set by the loader from where the entry came from; any value in the file is ignored.
	 */
	allowShell?: boolean;
	/**
	 * Where the entry was loaded from: the user's global glossary (or a local file it includes),
	 * the project glossary (or a local file it includes), or a URL include at any depth.
	 * Set by the loader; any value in the file is ignored.
	 */
	origin?: GlossaryOrigin;
};

export type GlossaryOrigin = "global" | "project" | "remote";

export type CompiledEntry = GlossaryEntry & { matcher: RegExp };

export type GlossaryIO = {
	/** File text, or undefined when the file does not exist. */
	readFile(path: string): Promise<string | undefined>;
	exists(path: string): Promise<boolean>;
	/** GET a URL; resolve body text, reject on non-2xx / network error. */
	fetchText(url: string, headers: Record<string, string>): Promise<string>;
	/** GitHub token from GITHUB_TOKEN or `gh auth token`; undefined if none. */
	githubToken(): Promise<string | undefined>;
	/** Run `command` through a shell in `cwd` with a 5s timeout. */
	runShell(command: string, cwd: string): Promise<{ ok: true; stdout: string } | { ok: false; error: string }>;
};

export type LoadResult = {
	entries: CompiledEntry[];
	/** Display labels of glossary files found (`~/.claude/glossary.json`, `.claude/glossary.jsonl`). */
	files: string[];
	warnings: string[];
	/** Fatal load error (bad JSON, invalid entry, ambiguous .json+.jsonl); entries is [] when set. */
	error?: string;
};

export const GLOSSARY_HEADING = "## Glossary";
export const GLOSSARY_PREAMBLE =
	"The user's prompt referenced explicit project glossary handles. Treat the following definitions as authoritative for the rest of this session. Reuse them exactly as project-local language, and do not ask the user to restate them unless the definitions conflict or are ambiguous.";

// --- POSIX path helpers (no Node `path` in the plugin engine) ---

function isAbsolutePath(p: string): boolean {
	return p.startsWith("/");
}

function normalizePath(p: string): string {
	const out: string[] = [];
	for (const seg of p.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") {
			if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
			else if (!isAbsolutePath(p)) out.push("..");
			continue;
		}
		out.push(seg);
	}
	return (isAbsolutePath(p) ? "/" : "") + out.join("/");
}

function joinPath(...parts: string[]): string {
	return normalizePath(parts.filter(Boolean).join("/"));
}

function resolvePath(cwd: string, p: string): string {
	return isAbsolutePath(p) ? normalizePath(p) : normalizePath(`${cwd}/${p}`);
}

function relativePath(from: string, to: string): string {
	const a = normalizePath(from).split("/").filter(Boolean);
	const b = normalizePath(to).split("/").filter(Boolean);
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}

/** Global glossary base path (no extension): `<home>/.claude/glossary`. */
export function globalGlossaryBase(home: string): string {
	return joinPath(home, ".claude", "glossary");
}

/** Project glossary base path (no extension): `<cwd>/.claude/glossary`. */
export function projectGlossaryBase(cwd: string): string {
	return joinPath(cwd, ".claude", "glossary");
}

function errMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termToPattern(term: string): string {
	return escapeRegExp(term.trim()).replace(/\s+/g, "\\s+");
}

export function buildMatcher(entry: GlossaryEntry): RegExp {
	if (entry.pattern) {
		return new RegExp(entry.pattern, entry.flags ?? "iu");
	}

	const variants = [entry.term, ...(entry.aliases ?? [])]
		.map((value) => value.trim())
		.filter(Boolean)
		.map(termToPattern);

	return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${variants.join("|")})(?![\\p{L}\\p{N}_])`, entry.flags ?? "iu");
}

function matchesText(matcher: RegExp, text: string): boolean {
	matcher.lastIndex = 0;
	const matched = matcher.test(text);
	matcher.lastIndex = 0;
	return matched;
}

/** Entries whose matcher hits `text`, excluding terms in `exclude`. Order preserved. */
export function matchEntries(entries: CompiledEntry[], text: string, exclude?: ReadonlySet<string>): CompiledEntry[] {
	return entries.filter((entry) => !exclude?.has(entry.term) && matchesText(entry.matcher, text));
}

/** All match ranges in `text` across entries, merged and sorted (for prompt highlighting). */
export function matchRanges(entries: CompiledEntry[], text: string): Array<{ start: number; end: number }> {
	const ranges: Array<{ start: number; end: number }> = [];
	for (const entry of entries) {
		const matcher = new RegExp(entry.matcher.source, entry.matcher.flags.replace("g", "") + "g");
		let m: RegExpExecArray | null;
		while ((m = matcher.exec(text)) !== null) {
			if (m[0].length === 0) { matcher.lastIndex++; continue; }
			ranges.push({ start: m.index, end: m.index + m[0].length });
		}
	}
	ranges.sort((a, b) => a.start - b.start);
	const merged: Array<{ start: number; end: number }> = [];
	for (const r of ranges) {
		const last = merged[merged.length - 1];
		if (last && r.start < last.end) last.end = Math.max(last.end, r.end);
		else merged.push({ ...r });
	}
	return merged;
}

/** Case-insensitive lookup by term (not alias). */
export function findTerm(entries: CompiledEntry[], term: string): CompiledEntry | undefined {
	const key = term.trim().toLowerCase();
	return entries.find((e) => e.term.toLowerCase() === key);
}

function extractRefs(definition: string): string[] {
	return [...definition.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]!.trim());
}

export const SHELL_DISABLED_MARKER = "[shell template disabled: remote glossary source]";

/**
 * Expand `{{cmd}}` placeholders; each distinct command runs once; failures become `[error: msg]`.
 * Without `allowShell` nothing runs and every placeholder becomes `SHELL_DISABLED_MARKER`.
 */
export async function expandTemplate(
	io: GlossaryIO,
	definition: string,
	cwd: string,
	opts: { allowShell: boolean },
): Promise<string> {
	if (!definition.includes("{{")) return definition;
	const matches = [...definition.matchAll(/\{\{(.+?)\}\}/g)];
	if (matches.length === 0) return definition;
	if (!opts.allowShell) return definition.replace(/\{\{(.+?)\}\}/g, SHELL_DISABLED_MARKER);

	const results = new Map<string, string>();
	for (const match of matches) {
		const command = match[1]!.trim();
		if (results.has(command)) continue;
		let output: string;
		try {
			const res = await io.runShell(command, cwd);
			output = res.ok ? res.stdout.trim() : `[error: ${res.error.trim()}]`;
		} catch (error) {
			output = `[error: ${errMessage(error).split("\n")[0]}]`;
		}
		results.set(command, output);
	}

	return definition.replace(/\{\{(.+?)\}\}/g, (_, cmd: string) => results.get(cmd.trim()) ?? "");
}

/** `### \`term\`\n<definition>` */
export function formatEntry(entry: Pick<GlossaryEntry, "term" | "definition">): string {
	return `### \`${entry.term}\`\n${entry.definition.trim()}`.trim();
}

export function buildContextBlock(
	entries: Array<Pick<GlossaryEntry, "term" | "definition">>,
	opts: { includePreamble: boolean; toolName: string },
): string {
	const injected = entries.map(formatEntry).join("\n\n");
	const hasRefs = entries.some((entry) => extractRefs(entry.definition).length > 0);
	const refHint = hasRefs
		? `\n\nSome definitions above contain \`[[term-name]]\` cross-references to related glossary terms. Use the \`${opts.toolName}\` tool to retrieve a referenced term's definition if it is relevant to the current task.`
		: "";
	const header = opts.includePreamble ? `${GLOSSARY_HEADING}\n${GLOSSARY_PREAMBLE}` : GLOSSARY_HEADING;
	return `${header}\n\n${injected}${refHint}`;
}

/** Case-insensitive filter over term, aliases, definition (for the browser pane). */
export function filterEntries(entries: CompiledEntry[], query: string): CompiledEntry[] {
	if (query === "") return [...entries];
	const q = query.toLowerCase();
	return entries.filter(
		(e) =>
			e.term.toLowerCase().includes(q) ||
			e.aliases?.some((a) => a.toLowerCase().includes(q)) ||
			e.definition.toLowerCase().includes(q),
	);
}

// --- Loading ---

function describeGlossaryEntry(entry: Partial<GlossaryEntry>, index: number): string {
	const term = typeof entry.term === "string" ? entry.term.trim() : "";
	return term ? `entry ${index + 1} (term: ${term})` : `entry ${index + 1}`;
}

function validateGlossaryEntry(entry: GlossaryEntry, index: number): GlossaryEntry {
	if (typeof entry.term !== "string" || entry.term.trim().length === 0) {
		throw new Error(`Invalid glossary ${describeGlossaryEntry(entry, index)}: missing or empty term`);
	}

	if (typeof entry.definition !== "string" || entry.definition.trim().length === 0) {
		throw new Error(`Invalid glossary ${describeGlossaryEntry(entry, index)}: missing or empty definition`);
	}

	if (entry.aliases !== undefined && !Array.isArray(entry.aliases)) {
		throw new Error(`Invalid glossary ${describeGlossaryEntry(entry, index)}: aliases must be an array of strings`);
	}

	if (Array.isArray(entry.aliases) && entry.aliases.some((alias) => typeof alias !== "string")) {
		throw new Error(`Invalid glossary ${describeGlossaryEntry(entry, index)}: aliases must contain only strings`);
	}

	if (entry.pattern !== undefined && typeof entry.pattern !== "string") {
		throw new Error(`Invalid glossary ${describeGlossaryEntry(entry, index)}: pattern must be a string`);
	}

	if (entry.flags !== undefined && typeof entry.flags !== "string") {
		throw new Error(`Invalid glossary ${describeGlossaryEntry(entry, index)}: flags must be a string`);
	}

	return {
		...entry,
		term: entry.term.trim(),
		definition: entry.definition.trim(),
		aliases: entry.aliases?.map((alias) => alias.trim()).filter(Boolean),
	};
}

function parseGlossaryFile(raw: string, glossaryFile: string): unknown[] {
	if (glossaryFile.endsWith(".jsonl")) {
		return raw
			.split(/\r?\n/)
			.map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
			.filter(({ line }) => line.length > 0)
			.map(({ line, lineNumber }) => {
				try {
					return JSON.parse(line) as unknown;
				} catch (error) {
					throw new Error(
						`Invalid glossary file ${glossaryFile}: line ${lineNumber} is not valid JSON (${errMessage(error)})`,
					);
				}
			});
	}

	const parsed = JSON.parse(raw) as unknown;
	if (!Array.isArray(parsed)) {
		throw new Error(`Invalid glossary file ${glossaryFile}: root value must be an array`);
	}
	return parsed;
}

async function resolveGlossaryFile(io: GlossaryIO, basePath: string): Promise<string> {
	const jsonFile = `${basePath}.json`;
	const jsonlFile = `${basePath}.jsonl`;
	const hasJson = await io.exists(jsonFile);
	const hasJsonl = await io.exists(jsonlFile);

	if (hasJson && hasJsonl) {
		throw new Error(`Ambiguous glossary configuration: found both ${jsonFile} and ${jsonlFile}. Keep only one.`);
	}

	return hasJsonl ? jsonlFile : jsonFile;
}

type GlossaryInclude = { include: string; allowShell?: unknown };

function isIncludeEntry(entry: unknown): entry is GlossaryInclude {
	return entry !== null && typeof entry === "object" && typeof (entry as any).include === "string";
}

function isUrl(source: string): boolean {
	return source.startsWith("http://") || source.startsWith("https://");
}

const GITHUB_HOSTS = new Set(["raw.githubusercontent.com", "gist.githubusercontent.com", "api.github.com", "github.com"]);

/** True only for https URLs whose host is exactly a GitHub content host: the only URLs that get the token. */
export function isGitHubUrl(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	return (
		parsed.protocol === "https:" &&
		parsed.port === "" &&
		parsed.username === "" &&
		parsed.password === "" &&
		GITHUB_HOSTS.has(parsed.hostname)
	);
}

/** Convert browser-visible GitHub URLs (/blob/, /raw/, gist raw) to raw-content URLs. */
function normalizeGitHubUrl(url: string): string {
	const blobMatch = url.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/(.+)$/);
	if (blobMatch) return `https://raw.githubusercontent.com/${blobMatch[1]}/${blobMatch[2]}`;

	const rawMatch = url.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)\/raw\/(.+)$/);
	if (rawMatch) return `https://raw.githubusercontent.com/${rawMatch[1]}/${rawMatch[2]}`;

	const gistRawMatch = url.match(/^https?:\/\/gist\.github\.com\/(.+\/raw\/.+)$/);
	if (gistRawMatch) return `https://gist.githubusercontent.com/${gistRawMatch[1]}`;

	return url;
}

async function fetchGlossaryUrl(io: GlossaryIO, url: string): Promise<string> {
	const headers: Record<string, string> = {};
	if (isGitHubUrl(url)) {
		const token = await io.githubToken();
		if (token) headers["Authorization"] = `Bearer ${token}`;
	}
	return io.fetchText(url, headers);
}

type LoadedFile = { found: boolean; entries: GlossaryEntry[]; path: string; label?: string };
/**
 * `trusted`: entries may run shell templates. True for the user's own glossary files and
 * local includes reached from them; false below a remote include unless that include
 * (written in a trusted file) opts in with `"allowShell": true`. Trust never widens.
 */
type Ctx = {
	io: GlossaryIO;
	home: string;
	cwd: string;
	visited: Set<string>;
	warnings: string[];
	trusted: boolean;
	/** Origin of the file being read; becomes "remote" below a URL include and never changes back. */
	origin: GlossaryOrigin;
};

/**
 * Expand raw parsed items (entries + include directives) into validated entries.
 * Includes resolve in place; the caller iterates in reverse so the first entry wins.
 */
async function resolveGlossaryItems(items: unknown[], defaultSource: string, ctx: Ctx): Promise<GlossaryEntry[]> {
	const result: GlossaryEntry[] = [];
	let entryCount = 0;

	for (const item of items) {
		if (isIncludeEntry(item)) {
			const rawSource = item.include.trim();
			const source = isUrl(rawSource) ? normalizeGitHubUrl(rawSource) : rawSource;
			const cycleKey = isUrl(source) ? source : resolvePath(ctx.cwd, source);

			if (ctx.visited.has(cycleKey)) {
				ctx.warnings.push(`Skipping circular include: ${source}`);
				continue;
			}
			ctx.visited.add(cycleKey);

			try {
				if (isUrl(source)) {
					const raw = await fetchGlossaryUrl(ctx.io, source);
					const pseudoFile = source.endsWith(".jsonl") ? "remote.jsonl" : "remote.json";
					const nested = parseGlossaryFile(raw, pseudoFile);
					const trusted = ctx.trusted && item.allowShell === true;
					result.push(...(await resolveGlossaryItems(nested, source, { ...ctx, trusted, origin: "remote" })));
				} else {
					const absBase = resolvePath(ctx.cwd, source);
					const hasExtension = absBase.endsWith(".json") || absBase.endsWith(".jsonl");
					const resolvedPath = hasExtension ? absBase : await resolveGlossaryFile(ctx.io, absBase);
					const loaded = await loadGlossaryFile(resolvedPath, ctx);
					if (!loaded.found) throw new Error(`file not found: ${resolvedPath}`);
					result.push(...loaded.entries);
				}
			} catch (error) {
				ctx.warnings.push(`Failed to include ${source}: ${errMessage(error)}`);
			}
		} else if (item && typeof item === "object" && (item as GlossaryEntry).enabled !== false) {
			const validated = validateGlossaryEntry(item as GlossaryEntry, entryCount++);
			// The file's own `source` is only a note after where the entry really came from,
			// so a remote file cannot pass itself off as one of the user's files.
			const note = typeof validated.source === "string" ? validated.source.trim() : "";
			const source = note && note !== defaultSource ? `${defaultSource} (${note})` : defaultSource;
			result.push({ ...validated, source, allowShell: ctx.trusted, origin: ctx.origin });
		}
	}

	return result;
}

async function loadGlossaryFile(file: string, ctx: Ctx): Promise<LoadedFile> {
	const raw = (await ctx.io.exists(file)) ? await ctx.io.readFile(file) : undefined;
	if (raw === undefined) {
		return { found: false, entries: [], path: file };
	}

	const parsed = parseGlossaryFile(raw, file);
	const home = ctx.home.replace(/\/+$/, "");
	const label = home && (file === home || file.startsWith(`${home}/`))
		? `~${file.slice(home.length)}`
		: relativePath(ctx.cwd, file);

	const entries = await resolveGlossaryItems(parsed, label, ctx);
	return { found: true, entries, path: file, label };
}

/**
 * Load global then project glossary, resolve includes, validate, merge
 * (first entry in a file wins; project overrides global by `term`), compile matchers.
 * Never throws: failures go to `error` / `warnings`.
 */
export async function loadGlossary(io: GlossaryIO, opts: { home: string; cwd: string }): Promise<LoadResult> {
	const warnings: string[] = [];
	try {
		const ctx: Omit<Ctx, "origin"> = { io, home: opts.home, cwd: opts.cwd, visited: new Set<string>(), warnings, trusted: true };
		const globalFile = await resolveGlossaryFile(io, globalGlossaryBase(opts.home));
		const projectFile = await resolveGlossaryFile(io, projectGlossaryBase(opts.cwd));
		const globalResult = await loadGlossaryFile(globalFile, { ...ctx, origin: "global" });
		const projectResult = await loadGlossaryFile(projectFile, { ...ctx, origin: "project" });

		// Merge in reverse so first entry in each file wins; project overrides global.
		// First occurrence wins: project before global, top of each file before bottom.
		// Iterating forward (not reversed) keeps entries in file order for the browser pane.
		const merged = new Map<string, GlossaryEntry>();
		for (const entry of [...projectResult.entries, ...globalResult.entries]) {
			if (!merged.has(entry.term)) merged.set(entry.term, entry);
		}

		const entries: CompiledEntry[] = Array.from(merged.values()).map((entry, index) => {
			try {
				return { ...entry, matcher: buildMatcher(entry) };
			} catch (error) {
				throw new Error(`Invalid glossary ${describeGlossaryEntry(entry, index)}: ${errMessage(error)}`);
			}
		});

		const files = [globalResult, projectResult].filter((r) => r.found).map((r) => r.label ?? r.path);
		return { entries, files, warnings };
	} catch (error) {
		return { entries: [], files: [], warnings, error: errMessage(error) };
	}
}
