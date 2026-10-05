import { test, expect, describe } from 'claude-code/testing'
import {
	buildContextBlock, buildMatcher, expandTemplate, filterEntries, findTerm, formatEntry,
	globalGlossaryBase, isGitHubUrl, SHELL_DISABLED_MARKER, loadGlossary, matchEntries, matchRanges, projectGlossaryBase,
	GLOSSARY_HEADING, GLOSSARY_PREAMBLE,
} from './glossary'
import type { CompiledEntry, GlossaryEntry, GlossaryIO } from './glossary'

const HOME = '/home/u'
const CWD = '/work/proj'

type Fake = GlossaryIO & { fetched: Array<{ url: string; headers: Record<string, string> }>; ran: string[] }

function fakeIO(
	files: Record<string, string> = {},
	urls: Record<string, string> = {},
	opts: { token?: string; shell?: Record<string, string | Error> } = {},
): Fake {
	const fetched: Fake['fetched'] = []
	const ran: string[] = []
	return {
		fetched,
		ran,
		readFile: async (p) => files[p],
		exists: async (p) => p in files,
		fetchText: async (url, headers) => {
			fetched.push({ url, headers })
			if (!(url in urls)) throw new Error('HTTP 404 Not Found')
			return urls[url]!
		},
		githubToken: async () => opts.token,
		runShell: async (cmd) => {
			ran.push(cmd)
			const r = opts.shell?.[cmd]
			if (r === undefined || r instanceof Error) return { ok: false, error: r?.message ?? 'not found' }
			return { ok: true, stdout: r + '\n' }
		},
	}
}

const load = (io: GlossaryIO) => loadGlossary(io, { home: HOME, cwd: CWD })
const G = `${HOME}/.claude/glossary`
const P = `${CWD}/.claude/glossary`
const j = (v: unknown) => JSON.stringify(v)

function compiled(e: GlossaryEntry): CompiledEntry {
	return { ...e, matcher: buildMatcher(e) }
}

describe('paths', () => {
	test('base paths', async () => {
		expect(globalGlossaryBase('/home/u')).toBe('/home/u/.claude/glossary')
		expect(projectGlossaryBase('/work/proj/')).toBe('/work/proj/.claude/glossary')
	})
})

describe('matching', () => {
	test('term, alias, case-insensitive', async () => {
		const e = compiled({ term: 'Grill Me', definition: 'd', aliases: ['grilling'] })
		expect(matchEntries([e], 'please grill me now')).toHaveLength(1)
		expect(matchEntries([e], 'GRILLING time')).toHaveLength(1)
		expect(matchEntries([e], 'nothing here')).toHaveLength(0)
	})
	test('multi-word tolerates whitespace runs', async () => {
		const e = compiled({ term: 'grill me', definition: 'd' })
		expect(matchEntries([e], 'grill   \n me')).toHaveLength(1)
	})
	test('dashed terms and regex chars are escaped', async () => {
		const e = compiled({ term: 'foo-bar', definition: 'd' })
		expect(matchEntries([e], 'use foo-bar here')).toHaveLength(1)
		expect(matchEntries([e], 'foo bar')).toHaveLength(0)
		const dot = compiled({ term: 'a.b', definition: 'd' })
		expect(matchEntries([dot], 'axb')).toHaveLength(0)
		expect(matchEntries([dot], 'a.b')).toHaveLength(1)
	})
	test('unicode word boundaries', async () => {
		const e = compiled({ term: 'cat', definition: 'd' })
		expect(matchEntries([e], 'concat')).toHaveLength(0)
		expect(matchEntries([e], 'cats')).toHaveLength(0)
		expect(matchEntries([e], 'cat_x')).toHaveLength(0)
		expect(matchEntries([e], 'ñcat')).toHaveLength(0)
		expect(matchEntries([e], '(cat)')).toHaveLength(1)
	})
	test('custom pattern and flags', async () => {
		const e = compiled({ term: 'x', definition: 'd', pattern: 'ab+c' })
		expect(matchEntries([e], 'xxABBBCxx')).toHaveLength(1)
		const cs = compiled({ term: 'x', definition: 'd', pattern: 'abc', flags: 'u' })
		expect(matchEntries([cs], 'ABC')).toHaveLength(0)
		expect(matchEntries([cs], 'abc')).toHaveLength(1)
	})
	test('exclude set and global-flag matchers are stateless', async () => {
		const a = compiled({ term: 'a', definition: 'd', pattern: 'a', flags: 'g' })
		const b = compiled({ term: 'b', definition: 'd' })
		expect(matchEntries([a, b], 'a b', new Set(['b'])).map((e) => e.term)).toEqual(['a'])
		expect(matchEntries([a], 'a')).toHaveLength(1)
		expect(matchEntries([a], 'a')).toHaveLength(1)
	})
	test('matchRanges merges overlaps and sorts', async () => {
		const x = compiled({ term: 'foo bar', definition: 'd' })
		const y = compiled({ term: 'bar baz', definition: 'd' })
		const z = compiled({ term: 'zed', definition: 'd' })
		expect(matchRanges([z, x, y], 'foo bar baz and zed')).toEqual([{ start: 0, end: 11 }, { start: 16, end: 19 }])
		expect(matchRanges([x], 'nope')).toEqual([])
	})
	test('findTerm is case-insensitive and ignores aliases', async () => {
		const e = compiled({ term: 'Grill', definition: 'd', aliases: ['bbq'] })
		expect(findTerm([e], ' grill ')).toBe(e)
		expect(findTerm([e], 'bbq')).toBeUndefined()
	})
	test('filterEntries searches term, aliases, definition', async () => {
		const a = compiled({ term: 'Alpha', definition: 'first', aliases: ['one'] })
		const b = compiled({ term: 'Beta', definition: 'Mentions GAMMA' })
		expect(filterEntries([a, b], '')).toHaveLength(2)
		expect(filterEntries([a, b], 'alp')).toEqual([a])
		expect(filterEntries([a, b], 'ONE')).toEqual([a])
		expect(filterEntries([a, b], 'gamma')).toEqual([b])
		expect(filterEntries([a, b], 'zzz')).toEqual([])
	})
})

describe('loading', () => {
	test('no files', async () => {
		const r = await load(fakeIO())
		expect(r.entries).toEqual([])
		expect(r.files).toEqual([])
		expect(r.error).toBeUndefined()
	})
	test('json with default source labels and trimming', async () => {
		const r = await load(fakeIO({
			[`${G}.json`]: j([{ term: ' g ', definition: ' gd ', aliases: [' x ', ''] }]),
			[`${P}.json`]: j([{ term: 'p', definition: 'pd' }]),
		}))
		expect(r.error).toBeUndefined()
		expect(r.files).toEqual(['~/.claude/glossary.json', '.claude/glossary.json'])
		const g = r.entries.find((e) => e.term === 'g')!
		expect(g.definition).toBe('gd')
		expect(g.aliases).toEqual(['x'])
		expect(g.source).toBe('~/.claude/glossary.json')
		expect(r.entries.find((e) => e.term === 'p')!.source).toBe('.claude/glossary.json')
	})
	test('jsonl parses, skips blank lines', async () => {
		const r = await load(fakeIO({
			[`${P}.jsonl`]: `${j({ term: 'a', definition: 'A' })}\r\n\n${j({ term: 'b', definition: 'B' })}\n`,
		}))
		expect(r.entries).toHaveLength(2)
		expect(r.files).toEqual(['.claude/glossary.jsonl'])
	})
	test('jsonl error includes line number', async () => {
		const r = await load(fakeIO({ [`${P}.jsonl`]: `${j({ term: 'a', definition: 'A' })}\n\n{oops\n` }))
		expect(r.entries).toEqual([])
		expect(r.error).toMatch(/glossary\.jsonl: line 3 is not valid JSON/)
	})
	test('json root must be an array', async () => {
		const r = await load(fakeIO({ [`${P}.json`]: '{}' }))
		expect(r.error).toMatch(/root value must be an array/)
	})
	test('ambiguous json + jsonl', async () => {
		const r = await load(fakeIO({ [`${P}.json`]: '[]', [`${P}.jsonl`]: '' }))
		expect(r.error).toMatch(/Ambiguous glossary configuration: found both/)
	})
	test('validation errors', async () => {
		const bad = async (entry: unknown) => (await load(fakeIO({ [`${P}.json`]: j([entry]) }))).error
		expect(await bad({ definition: 'd' })).toBe('Invalid glossary entry 1: missing or empty term')
		expect(await bad({ term: 't' })).toBe('Invalid glossary entry 1 (term: t): missing or empty definition')
		expect(await bad({ term: 't', definition: 'd', aliases: 'x' })).toMatch(/aliases must be an array of strings/)
		expect(await bad({ term: 't', definition: 'd', aliases: [1] })).toMatch(/aliases must contain only strings/)
		expect(await bad({ term: 't', definition: 'd', pattern: 1 })).toMatch(/pattern must be a string/)
		expect(await bad({ term: 't', definition: 'd', flags: 1 })).toMatch(/flags must be a string/)
		expect(await bad({ term: 't', definition: 'd', pattern: '(' })).toMatch(/^Invalid glossary entry 1 \(term: t\): /)
	})
	test('a bad regex from a URL include drops only that entry', async () => {
		const R = 'https://example.com/r.json'
		const r = await load(fakeIO(
			{ [`${G}.json`]: j([{ term: 'mine', definition: 'M' }, { include: R }]) },
			{ [R]: j([{ term: 'bad', definition: 'B', pattern: '(' }, { term: 'good', definition: 'G' }, { term: 'badflags', definition: 'F', flags: 'zz' }]) },
		))
		expect(r.error).toBeUndefined()
		expect(r.entries.map((e) => e.term)).toEqual(['mine', 'good'])
		expect(r.warnings).toHaveLength(2)
		expect(r.warnings[0]).toMatch(/^Skipping invalid glossary entry 2 \(term: bad\): .* \(from https:\/\/example\.com\/r\.json\)$/)
	})
	test('enabled:false is skipped', async () => {
		const r = await load(fakeIO({ [`${P}.json`]: j([{ term: 'a', definition: 'A', enabled: false }, { term: 'b', definition: 'B' }]) }))
		expect(r.entries.map((e) => e.term)).toEqual(['b'])
	})
	test('explicit source is kept', async () => {
		const r = await load(fakeIO({ [`${P}.json`]: j([{ term: 'a', definition: 'A', source: 'custom' }]) }))
		expect(r.entries[0]!.source).toBe('custom')
	})
	test('first entry in a file wins; project overrides global', async () => {
		const r = await load(fakeIO({
			[`${G}.json`]: j([{ term: 'dup', definition: 'g1' }, { term: 'dup', definition: 'g2' }, { term: 'only-g', definition: 'x' }]),
			[`${P}.json`]: j([{ term: 'dup', definition: 'p1' }, { term: 'dup', definition: 'p2' }]),
		}))
		expect(r.entries.find((e) => e.term === 'dup')!.definition).toBe('p1')
		expect(r.entries.find((e) => e.term === 'only-g')).toBeDefined()
		expect(r.entries.filter((e) => e.term === 'dup')).toHaveLength(1)
	})
	test('global only prefers jsonl when only it exists', async () => {
		const r = await load(fakeIO({ [`${G}.jsonl`]: j({ term: 'a', definition: 'A' }) }))
		expect(r.files).toEqual(['~/.claude/glossary.jsonl'])
	})
})

describe('includes', () => {
	test('relative include with extension, source label', async () => {
		const r = await load(fakeIO({
			[`${P}.json`]: j([{ include: 'shared/terms.json' }, { term: 'own', definition: 'O' }]),
			[`${CWD}/shared/terms.json`]: j([{ term: 'inc', definition: 'I' }]),
		}))
		expect(r.warnings).toEqual([])
		expect(r.entries.find((e) => e.term === 'inc')!.source).toBe('shared/terms.json')
		expect(r.entries).toHaveLength(2)
	})
	test('absolute and extensionless includes (.jsonl preferred if only it exists)', async () => {
		const r = await load(fakeIO({
			[`${P}.json`]: j([{ include: '/abs/a' }, { include: 'b' }]),
			['/abs/a.json']: j([{ term: 'a', definition: 'A' }]),
			[`${CWD}/b.jsonl`]: j({ term: 'b', definition: 'B' }),
		}))
		expect(r.warnings).toEqual([])
		expect(r.entries.map((e) => e.term).sort()).toEqual(['a', 'b'])
	})
	test('extensionless include with both files warns', async () => {
		const r = await load(fakeIO({
			[`${P}.json`]: j([{ include: 'b' }]),
			[`${CWD}/b.json`]: '[]',
			[`${CWD}/b.jsonl`]: '',
		}))
		expect(r.warnings[0]).toMatch(/^Failed to include b: Ambiguous/)
	})
	test('include order: includes expand in place, earlier wins', async () => {
		const r = await load(fakeIO({
			[`${P}.json`]: j([{ include: 'x.json' }, { term: 't', definition: 'local' }]),
			[`${CWD}/x.json`]: j([{ term: 't', definition: 'included' }]),
		}))
		expect(r.entries.find((e) => e.term === 't')!.definition).toBe('included')
	})
	test('nested includes are recursive', async () => {
		const r = await load(fakeIO({
			[`${P}.json`]: j([{ include: 'a.json' }]),
			[`${CWD}/a.json`]: j([{ include: 'b.json' }, { term: 'a', definition: 'A' }]),
			[`${CWD}/b.json`]: j([{ term: 'b', definition: 'B' }]),
		}))
		expect(r.entries.map((e) => e.term).sort()).toEqual(['a', 'b'])
	})
	test('cycle is skipped with warning', async () => {
		const r = await load(fakeIO({
			[`${P}.json`]: j([{ include: 'a.json' }]),
			[`${CWD}/a.json`]: j([{ include: 'a.json' }, { term: 'a', definition: 'A' }]),
		}))
		expect(r.error).toBeUndefined()
		expect(r.warnings).toEqual(['Skipping circular include: a.json'])
		expect(r.entries.map((e) => e.term)).toEqual(['a'])
	})
	test('failed include warns and continues', async () => {
		const r = await load(fakeIO({
			[`${P}.json`]: j([{ include: 'missing.json' }, { include: 'http://h/x.json' }, { term: 'ok', definition: 'O' }]),
		}))
		expect(r.error).toBeUndefined()
		expect(r.entries.map((e) => e.term)).toEqual(['ok'])
		expect(r.warnings).toEqual([
			`Failed to include missing.json: file not found: ${CWD}/missing.json`,
			'Failed to include http://h/x.json: HTTP 404 Not Found',
		])
	})
	test('URL include: plain host gets no auth header, source label is the URL', async () => {
		const io = fakeIO(
			{ [`${P}.json`]: j([{ include: 'https://example.com/g.json' }]) },
			{ 'https://example.com/g.json': j([{ term: 'u', definition: 'U' }]) },
			{ token: 'tok' },
		)
		const r = await load(io)
		expect(r.entries[0]!.source).toBe('https://example.com/g.json')
		expect(io.fetched).toEqual([{ url: 'https://example.com/g.json', headers: {} }])
	})
	test('URL include: remote .jsonl parsed', async () => {
		const r = await load(fakeIO(
			{ [`${P}.json`]: j([{ include: 'https://example.com/g.jsonl' }]) },
			{ 'https://example.com/g.jsonl': `${j({ term: 'u', definition: 'U' })}\n${j({ term: 'v', definition: 'V' })}\n` },
		))
		expect(r.entries).toHaveLength(2)
	})
	test('GitHub blob URL is normalized and gets Bearer token', async () => {
		const raw = 'https://raw.githubusercontent.com/me/repo/main/dir/g.json'
		const io = fakeIO(
			{ [`${P}.json`]: j([{ include: 'https://github.com/me/repo/blob/main/dir/g.json' }]) },
			{ [raw]: j([{ term: 'gh', definition: 'G' }]) },
			{ token: 'sekret' },
		)
		const r = await load(io)
		expect(r.warnings).toEqual([])
		expect(r.entries[0]!.source).toBe(raw)
		expect(io.fetched).toEqual([{ url: raw, headers: { Authorization: 'Bearer sekret' } }])
	})
	test('GitHub /raw/ and gist raw normalization', async () => {
		const a = 'https://raw.githubusercontent.com/me/repo/main/g.json'
		const b = 'https://gist.githubusercontent.com/me/abc123/raw/g.json'
		const io = fakeIO(
			{ [`${P}.json`]: j([{ include: 'https://github.com/me/repo/raw/main/g.json' }, { include: 'https://gist.github.com/me/abc123/raw/g.json' }]) },
			{ [a]: j([{ term: 'a', definition: 'A' }]), [b]: j([{ term: 'b', definition: 'B' }]) },
		)
		const r = await load(io)
		expect(r.warnings).toEqual([])
		expect(io.fetched.map((f) => f.url)).toEqual([a, b])
		expect(io.fetched[0]!.headers).toEqual({})
	})
	test('invalid entry inside an include is a warning, not fatal', async () => {
		const r = await load(fakeIO({
			[`${P}.json`]: j([{ include: 'bad.json' }, { term: 'ok', definition: 'O' }]),
			[`${CWD}/bad.json`]: j([{ term: 'x' }]),
		}))
		expect(r.error).toBeUndefined()
		expect(r.warnings[0]).toMatch(/^Failed to include bad\.json: Invalid glossary entry 1/)
		expect(r.entries.map((e) => e.term)).toEqual(['ok'])
	})
})

describe('templates and formatting', () => {
	test('no placeholders: untouched, no shell', async () => {
		const io = fakeIO()
		expect(await expandTemplate(io, 'plain', CWD, { allowShell: true })).toBe('plain')
		expect(io.ran).toEqual([])
	})
	test('dedups commands and trims output', async () => {
		const io = fakeIO({}, {}, { shell: { 'echo hi': 'hi' } })
		expect(await expandTemplate(io, 'a {{echo hi}} b {{ echo hi }}', CWD, { allowShell: true })).toBe('a hi b hi')
		expect(io.ran).toEqual(['echo hi'])
	})
	test('failure becomes error marker', async () => {
		const io = fakeIO()
		expect(await expandTemplate(io, 'x {{nope}} y', CWD, { allowShell: true })).toBe('x [error: not found] y')
	})
	test('without allowShell nothing runs and placeholders become the disabled marker', async () => {
		const io = fakeIO({}, {}, { shell: { 'echo hi': 'hi' } })
		expect(await expandTemplate(io, 'a {{echo hi}} b {{rm -rf ~}}', CWD, { allowShell: false }))
			.toBe(`a ${SHELL_DISABLED_MARKER} b ${SHELL_DISABLED_MARKER}`)
		expect(io.ran).toEqual([])
	})
	test('formatEntry', async () => {
		expect(formatEntry({ term: 'T', definition: '  body \n' })).toBe('### `T`\nbody')
	})
	test('buildContextBlock with preamble, no refs', async () => {
		const out = buildContextBlock([{ term: 'a', definition: 'A' }, { term: 'b', definition: 'B' }], { includePreamble: true, toolName: 'glossary_lookup' })
		expect(out).toBe(`${GLOSSARY_HEADING}\n${GLOSSARY_PREAMBLE}\n\n### \`a\`\nA\n\n### \`b\`\nB`)
	})
	test('buildContextBlock without preamble, with ref hint', async () => {
		const out = buildContextBlock([{ term: 'a', definition: 'see [[b]]' }], { includePreamble: false, toolName: 'mcp__glossary__lookup' })
		expect(out.startsWith(`${GLOSSARY_HEADING}\n\n### \`a\``)).toBe(true)
		expect(out).not.toContain('authoritative')
		expect(out).toContain('Use the `mcp__glossary__lookup` tool to retrieve a referenced term')
		expect(out).toContain('`[[term-name]]`')
	})
})

describe('GitHub token scope', () => {
	test('isGitHubUrl accepts only https on an exact GitHub host', async () => {
		for (const url of [
			'https://raw.githubusercontent.com/o/r/main/g.json',
			'https://gist.githubusercontent.com/u/id/raw/g.json',
			'https://api.github.com/repos/o/r/contents/g.json',
			'https://github.com/o/r/raw/main/g.json',
			'https://GitHub.com/o/r/raw/main/g.json',
		]) expect(isGitHubUrl(url)).toBe(true)
		for (const url of [
			'https://github.com.attacker.invalid/g.json',
			'https://raw.githubusercontent.com.attacker.invalid/g.json',
			'https://attacker.invalid/?u=https://github.com/x',
			'https://attacker.invalid/https://raw.githubusercontent.com/x',
			'https://github.com@attacker.invalid/g.json',
			'https://user:pw@github.com/o/r/raw/main/g.json',
			'https://notgithub.com/g.json',
			'https://github.com:8443/g.json',
			'http://raw.githubusercontent.com/o/r/main/g.json',
			'not a url',
		]) expect(isGitHubUrl(url)).toBe(false)
	})
	test('a lookalike host include is fetched without the token', async () => {
		const evil = 'https://github.com.attacker.invalid/g.json'
		const io = fakeIO(
			{ [`${P}.json`]: j([{ include: evil }]) },
			{ [evil]: j([{ term: 'x', definition: 'X' }]) },
			{ token: 'sekret' },
		)
		const r = await load(io)
		expect(r.entries.map((e) => e.term)).toEqual(['x'])
		expect(io.fetched).toEqual([{ url: evil, headers: {} }])
	})
	test('plain http GitHub raw URL is fetched without the token', async () => {
		const url = 'http://raw.githubusercontent.com/o/r/main/g.json'
		const io = fakeIO({ [`${P}.json`]: j([{ include: url }]) }, { [url]: j([{ term: 'x', definition: 'X' }]) }, { token: 'sekret' })
		await load(io)
		expect(io.fetched).toEqual([{ url, headers: {} }])
	})
})

describe('shell template trust', () => {
	const R = 'https://example.com/r.json'
	const R2 = 'https://example.com/r2.json'
	const shellOf = (r: Awaited<ReturnType<typeof load>>) => Object.fromEntries(r.entries.map((e) => [e.term, e.allowShell]))

	test('local entries and local includes may run shell; remote entries may not', async () => {
		const r = await load(fakeIO(
			{
				[`${P}.json`]: j([{ term: 'p', definition: 'P' }, { include: 'more.json' }, { include: R }]),
				[`${CWD}/more.json`]: j([{ term: 'm', definition: 'M' }]),
				[`${G}.json`]: j([{ term: 'g', definition: 'G' }]),
			},
			{ [R]: j([{ term: 'r', definition: '{{id}}' }]) },
		))
		expect(r.warnings).toEqual([])
		expect(shellOf(r)).toEqual({ p: true, m: true, r: false, g: true })
	})
	test('a remote file cannot grant itself shell, nor spoof a local source', async () => {
		const r = await load(fakeIO(
			{ [`${P}.json`]: j([{ include: R }]) },
			{ [R]: j([{ term: 'r', definition: '{{id}}', allowShell: true, source: '.claude/glossary.json' }]) },
		))
		expect(r.entries[0]!.allowShell).toBe(false)
	})
	test('allowShell on an include in a local file opts that remote source in', async () => {
		const r = await load(fakeIO(
			{ [`${P}.json`]: j([{ include: R, allowShell: true }]) },
			{ [R]: j([{ term: 'r', definition: '{{id}}' }]) },
		))
		expect(r.entries[0]!.allowShell).toBe(true)
	})
	test('allowShell must be exactly true', async () => {
		const r = await load(fakeIO(
			{ [`${P}.json`]: j([{ include: R, allowShell: 'yes' }]) },
			{ [R]: j([{ term: 'r', definition: '{{id}}' }]) },
		))
		expect(r.entries[0]!.allowShell).toBe(false)
	})
	test('trust never widens below a remote include', async () => {
		const r = await load(fakeIO(
			{
				[`${P}.json`]: j([{ include: R }]),
				[`${CWD}/local.json`]: j([{ term: 'l', definition: '{{id}}' }]),
			},
			{
				[R]: j([{ include: R2, allowShell: true }, { include: 'local.json' }]),
				[R2]: j([{ term: 'r2', definition: '{{id}}' }]),
			},
		))
		expect(r.warnings).toEqual([])
		expect(shellOf(r)).toEqual({ r2: false, l: false })
	})
})

describe('entry origin', () => {
	const R = 'https://example.com/r.json'
	test('the loader records global, project or remote, ignoring the file', async () => {
		const r = await load(fakeIO(
			{
				[`${G}.json`]: j([{ term: 'g', definition: 'G', origin: 'project' }, { include: '/home/u/more.json' }]),
				'/home/u/more.json': j([{ term: 'gm', definition: 'GM' }]),
				[`${P}.json`]: j([{ term: 'p', definition: 'P', origin: 'global' }, { include: R }]),
			},
			{ [R]: j([{ term: 'r', definition: 'R', origin: 'global' }]) },
		))
		expect(Object.fromEntries(r.entries.map((e) => [e.term, e.origin]))).toEqual({ p: 'project', r: 'remote', g: 'global', gm: 'global' })
	})
	test('a local file included below a remote include is remote', async () => {
		const r = await load(fakeIO(
			{ [`${P}.json`]: j([{ include: R }]), [`${CWD}/local.json`]: j([{ term: 'l', definition: 'L' }]) },
			{ [R]: j([{ include: 'local.json' }]) },
		))
		expect(r.entries[0]!.origin).toBe('remote')
	})
})
