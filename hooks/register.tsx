import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register } from 'claude-code';

import type { GlossaryPaneEntry } from '../types';
import { DEFAULT_GLOSSARY } from './default-glossary';
import {
	buildContextBlock,
	expandTemplate,
	filterEntries,
	findTerm,
	loadGlossary,
	matchEntries,
	matchRanges,
} from './glossary';
import type { CompiledEntry, GlossaryIO, LoadResult } from './glossary';

const PANE = 'glossary';
const TOOL = 'mcp__glossary__lookup';
const DEFAULT_OFFERED_KEY = 'defaultGlossaryOffered';

// State a drawing or a reload must see lives in `$.state` (it survives a hot
// reload of this module). Compiled entries hold RegExps, which are not plain
// data, so they stay in a module variable and are rebuilt by `session.start`
// (which fires again on every reload); the pane reads the plain copy.
const entriesState = atom({ plugin: 'glossary', key: 'entries' } as const, [] as GlossaryPaneEntry[]);
const loadedState = atom({ plugin: 'glossary', key: 'loaded' } as const, [] as string[]);
const preambleState = atom({ plugin: 'glossary', key: 'hasPreamble' } as const, false);
const queryState = atom({ plugin: 'glossary', key: 'query' } as const, '');
const selectedState = atom({ plugin: 'glossary', key: 'selected' } as const, null as string | null);
const errorState = atom({ plugin: 'glossary', key: 'error' } as const, null as string | null);

// Only the user's own prompts trigger injection, not notifications, peers,
// schedules or other plugins' prompts.
const USER_ORIGINS = new Set(['composer', 'bridge', 'sdk']);

const plural = (n: number) => `${n} entr${n === 1 ? 'y' : 'ies'}`;
const sources = (files: string[]) => (files.length === 0 ? '' : ` from ${files.join(' and ')}`);

let entries: CompiledEntry[] = [];
let home = '';
let cwd = '';

function makeIO($: EngineInterface): GlossaryIO {
	return {
		readFile: async (path) => ((await $.fs.exists(path)) ? String(await $.fs.read(path)) : undefined),
		exists: (path) => $.fs.exists(path),
		fetchText: async (url, headers) => {
			const res = await $.http.fetch(url, { headers });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return res.text;
		},
		githubToken: async () => {
			const fromEnv = await $.env.get('GITHUB_TOKEN');
			if (fromEnv) return fromEnv;
			try {
				const res = await $.process.run(['gh', 'auth', 'token'], { timeoutMs: 5000 });
				const token = res.stdout.trim();
				return res.exitCode === 0 && token ? token : undefined;
			} catch {
				return undefined;
			}
		},
		runShell: async (command, dir) => {
			try {
				const res = await $.process.run(['sh', '-c', command], { cwd: dir, timeoutMs: 5000 });
				return res.exitCode === 0
					? { ok: true, stdout: res.stdout }
					: { ok: false, error: res.stderr.trim() || `exit code ${res.exitCode}` };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}

function syncStatus($: EngineInterface, terms: string[]) {
	$.ui.status(terms.length === 0 ? undefined : `Glossary: ${terms.join(', ')}`);
};

async function markLoaded($: EngineInterface, terms: string[]) {
	const next = await update($, loadedState, (list) => [...list, ...terms.filter((t) => !list.includes(t))]);
	syncStatus($, next);
};

async function resetLoaded($: EngineInterface) {
	await update($, loadedState, () => []);
	await update($, preambleState, () => false);
	syncStatus($, []);
};

/** Load the files and publish the result to the module variable and `$.state`. */
async function load($: EngineInterface): Promise<LoadResult> {
	home = (await $.env.get('HOME')) ?? home;
	cwd = await $.session.cwd();
	const result = await loadGlossary(makeIO($), { home, cwd });
	entries = result.entries;
	await update($, entriesState, () =>
		entries.map((e) => ({
			term: e.term,
			definition: e.definition,
			aliases: e.aliases ?? [],
			source: e.source ?? '',
		})),
	);
	await update($, errorState, () => result.error ?? null);
	return result;
};

/**
 * pi installed the default glossary from npm's postinstall. A plugin has no
 * install hook, so do it on first session start: only when no global glossary
 * exists and we never offered it before (the `$.store` marker keeps us from
 * recreating it after the user deletes it).
 */
async function installDefault($: EngineInterface) {
	if (!home) return;
	if (await $.store.get(DEFAULT_OFFERED_KEY)) return;
	const base = `${home}/.claude/glossary`;
	if ((await $.fs.exists(`${base}.json`)) || (await $.fs.exists(`${base}.jsonl`))) return;
	await $.fs.write(`${base}.json`, `${JSON.stringify(DEFAULT_GLOSSARY, null, '\t')}\n`);
	await $.store.set(DEFAULT_OFFERED_KEY, true);
	$.ui.toast(`Glossary: wrote a default glossary to ~/.claude/glossary.json`);
};

export const register: Register = (on) => {
	on('session.start', async ($, e, next) => {
		home = (await $.env.get('HOME')) ?? '';
		// A hot reload re-runs session.start: `$.state` still holds the loaded
		// terms, so keep them (and the preamble flag) and stay quiet if the
		// glossary was already announced. A /clear resets them in session.end.
		const wasLoaded = (await read($, entriesState)).length > 0;
		try {
			await installDefault($);
		} catch (error) {
			$.ui.toast(`Glossary: could not write default glossary: ${error instanceof Error ? error.message : error}`);
		}

		const result = await load($);
		await $.command.register({
			name: 'glossary',
			description: 'Browse or reload the glossary',
			argumentHint: '[reload|close]',
		});
		await $.tool.register({
			name: 'lookup',
			description:
				'Look up a glossary term by name and get its definition. ' +
				'Use this when a loaded definition contains a [[term-name]] cross-reference that is relevant to the current task.',
			inputSchema: {
				type: 'object',
				properties: { term: { type: 'string', description: 'The term name to look up (case-insensitive)' } },
				required: ['term'],
			},
		});
		syncStatus($, await read($, loadedState));

		if (result.error) {
			$.ui.toast(`Glossary load failed: ${result.error}`);
		} else if (!wasLoaded) {
			for (const w of result.warnings) $.ui.toast(`Glossary warning: ${w}`);
			if (result.files.length > 0 && result.entries.length > 0) {
				$.ui.toast(`Glossary loaded: ${plural(result.entries.length)}${sources(result.files)}`);
			}
		}
		return next(e);
	});

	// A /clear starts a new conversation without a new session.start: nothing
	// injected so far is in context any more.
	on('session.end', async ($, e, next) => {
		await resetLoaded($);
		return next(e);
	});

	on('prompt.submit', async ($, e, next) => {
		try {
			if (!USER_ORIGINS.has(e.origin.kind) || entries.length === 0 || !e.text.trim()) return next(e);
			const loaded = new Set(await read($, loadedState));
			const matched = matchEntries(entries, e.text, loaded);
			if (matched.length === 0) return next(e);

			const dir = cwd || (await $.session.cwd());
			const io = makeIO($);
			const expanded = await Promise.all(
				matched.map(async (entry) => ({ ...entry, definition: await expandTemplate(io, entry.definition, dir, { allowShell: entry.allowShell === true }) })),
			);
			const hasPreamble = await read($, preambleState);
			const block = buildContextBlock(expanded, { includePreamble: !hasPreamble, toolName: TOOL });
			await update($, preambleState, () => true);
			await markLoaded($, matched.map((m) => m.term));
			return next({ ...e, context: [...(e.context ?? []), block] });
		} catch (error) {
			// Never block a prompt over the glossary.
			$.ui.log(`glossary: prompt injection failed: ${error instanceof Error ? error.message : error}`, { to: 'debug' });
			return next(e);
		}
	});

	on('tool.call', { tool: TOOL }, async ($, e) => {
		const term = String((e as { term?: unknown }).term ?? '').trim();
		const entry = findTerm(entries, term) ?? matchEntries(entries, term)[0];
		if (!entry) return { result: `Glossary term not found: "${term}"` };
		if (!(await read($, loadedState)).includes(entry.term)) await markLoaded($, [entry.term]);
		const definition = await expandTemplate(makeIO($), entry.definition, cwd || (await $.session.cwd()), {
			allowShell: entry.allowShell === true,
		});
		return { result: `### \`${entry.term}\`\n${definition}` };
	});

	// Live highlight of glossary terms in the prompt box.
	on('prompt.edit', async ($, e, next) => {
		const r = await next(e);
		if (entries.length === 0 || !r.text) return r;
		const marks = matchRanges(entries, r.text).map((m) => ({
			start: m.start,
			end: m.end,
			bold: true,
			color: 'warning',
		}));
		return marks.length === 0 ? r : { ...r, decorations: [...(r.decorations ?? []), ...marks] };
	});

	// Compaction summarizes the conversation, and the definitions we injected
	// may not survive the summary. Forget what was loaded (and the preamble) so
	// terms inject again when next mentioned. Skipped compactions and the
	// `precompute` dry run change nothing, so they reset nothing.
	on('session.compact', async ($, e, next) => {
		const r = await next(e);
		if (e.trigger !== 'precompute' && e.agentId === undefined && r.messages !== undefined) await resetLoaded($);
		return r;
	});

	const listing = (list: CompiledEntry[]) =>
		[`Glossary: ${plural(list.length)}`, ...list.map((x) => `- ${x.term}${x.aliases?.length ? ` (${x.aliases.join(', ')})` : ''}`)].join('\n');

	on('command.run', { command: 'glossary' }, async ($, e) => {
		const arg = e.args.trim();
		if (arg && arg !== 'reload' && arg !== 'close') return { text: 'Usage: /glossary, /glossary reload or /glossary close' };

		// Esc only closes the pane while it holds the keys or the prompt is idle and empty,
		// so offer a close that always works: `/glossary close`, or `/glossary` again.
		const isOpen = (await $.ui.panes()).some((p) => p.id === PANE);
		if (arg === 'close' || (!arg && isOpen)) {
			if (!isOpen) return { text: 'Glossary browser is not open.' };
			await $.ui.close({ id: PANE });
			return { text: 'Glossary browser closed.' };
		}

		if (arg === 'reload') {
			await resetLoaded($);
			const result = await load($);
			if (result.error) {
				$.ui.toast(`Glossary reload failed: ${result.error}`);
				return { text: `Glossary reload failed: ${result.error}` };
			}
			for (const w of result.warnings) $.ui.toast(`Glossary warning: ${w}`);
			const text =
				result.files.length > 0
					? `Glossary reloaded: ${plural(result.entries.length)}${sources(result.files)}`
					: 'No glossary files found';
			$.ui.toast(text);
			return { text };
		}

		const error = await read($, errorState);
		if (error) return { text: `Glossary load error: ${error}` };
		if (entries.length === 0) return { text: 'No glossary entries loaded' };

		await update($, queryState, () => '');
		await update($, selectedState, () => null);
		// A plain -p run has no surface, yet `$.ui.open` still reports the pane placed.
		if ((await $.session.surfaces()).length === 0) return { text: listing(entries) };
		// Ask for the whole list plus the search row; the engine may keep an earlier size.
		const rows = Math.min(entries.length, 30) + 3;
		const opened = await $.ui.open({ id: PANE, title: 'Glossary', focus: true, closeOnEscape: true, rows });
		// Where no surface draws the pane (a -p run, a narrow terminal), list instead.
		return opened.isPlaced ? { text: 'Glossary browser opened (Esc or /glossary close closes it).' } : { text: listing(entries) };
	});

	// Arrow keys / Tab walk the term buttons; the focused one is the selection.
	on('ui.focus', { requestId: PANE }, async ($, e, next) => {
		const r = await next(e);
		if (e.element?.startsWith('term:')) await update($, selectedState, () => e.element!.slice(5));
		return r;
	});

	on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
		const entriesNow = await read($, entriesState);
		const query = await read($, queryState);
		const picked = await read($, selectedState);
		const shown = filterEntries(
			entriesNow.map((p) => ({ ...p, aliases: p.aliases, matcher: /(?:)/ })),
			query,
		);
		const current = shown.find((s) => s.term === picked) ?? shown[0];
		const index = current ? shown.indexOf(current) : 0;

		if (e.surface === 'mobile') {
			const { Box, Text } = $.ui.resolve(e);
			return (
				<Box flexDirection="column">
					{entriesNow.map((x) => (
						<Text>{x.term}</Text>
					))}
				</Box>
			);
		}
		const { Box, Button, Input, Text } = $.ui.resolve(e);
		// The pane body less the search row; the engine scrolls whatever does not fit.
		const room = Math.max(3, (e.props.scroll?.bodyRows ?? (e.viewport?.rows ?? 24) - 8) - 1);
		const first = Math.max(0, Math.min(index - Math.floor(room / 2), shown.length - room));
		const window = shown.slice(first, first + room);

		const details = current
			? [
					<Text bold>{current.term}</Text>,
					<Text dimColor>{current.aliases?.length ? `aliases: ${current.aliases.join(', ')}` : ''}</Text>,
					<Text dimColor>{current.source ? `source: ${current.source}` : ''}</Text>,
					<Text>{''}</Text>,
					<Text>{current.definition}</Text>,
				]
			: [];

		return (
			<Box flexDirection="column">
				<Box flexDirection="row">
					<Box flexGrow={1}>
						<Input
							key="query"
							label="Search"
							placeholder="filter terms, aliases, definitions"
							value={query}
							autoFocus
							onInput={(value) => {
								void update($, queryState, () => value);
								void update($, selectedState, () => null);
							}}
							onSubmit={() => {}}
						/>
					</Box>
					<Button key="close" role="dismiss" label="Close" onPress={() => $.ui.close({ id: PANE })} />
				</Box>
				<Box flexDirection="row">
					<Box flexDirection="column" width="38%">
						{shown.length === 0 && <Text dimColor>No matches.</Text>}
						{window.map((s) => (
							<Button
								key={`term:${s.term}`}
								plain
								label={`${s === current ? '> ' : '  '}${s.term}`}
								onPress={() => update($, selectedState, () => s.term)}
							/>
						))}
						<Text dimColor>
							{shown.length === 0 ? 0 : index + 1}/{shown.length}
						</Text>
					</Box>
					<Box flexDirection="column" width="62%" paddingLeft={1}>
						{details}
					</Box>
				</Box>
				<Text dimColor>Tab: select · type to filter · Esc or /glossary close: close</Text>
			</Box>
		);
	});
};
