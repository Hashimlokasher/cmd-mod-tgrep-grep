// Routes the built-in `grep` tool through tgrep (https://github.com/microsoft/tgrep).
//
// `beforeToolCall` may return `result`, which answers the call without running the tool.
//
// The mod only activates when the session root has a `.tgrep` index AND a live tgrep
// server is answering for it. Without the server the index is a snapshot: it misses files
// created or edited since the last build and would report "No matches found" for code that
// exists. Anything unexpected (no index, dead server, bad regex, timeout) returns
// `undefined`, so the built-in ripgrep-backed grep runs instead.

import {existsSync} from 'node:fs';
import {join} from 'node:path';

import type {ModApi} from '@commandcode/harness';

const TIMEOUT_MS = 30_000;
const DEFAULT_HEAD_LIMIT = 250;
const STDERR_CAP = 8_192;

type Run = {stdout: string; stderr: string; code: number};

function asNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value)
		? value
		: undefined;
}

function buildArgs(
	input: Record<string, unknown>,
	noIndex: boolean
): string[] | undefined {
	const pattern = typeof input.pattern === 'string' ? input.pattern : '';
	if (!pattern) return undefined;

	const args: string[] = [];
	if (noIndex) args.push('--no-index');
	if (input['-i'] === true) args.push('-i');
	if (input.multiline === true) args.push('-U');
	// tgrep omits line numbers unless asked, even though its help calls it the default.
	if (input['-n'] !== false) args.push('-n');

	const before = asNumber(input['-B']);
	const after = asNumber(input['-A']);
	const context = asNumber(input['-C'] ?? input.context);
	if (before !== undefined) args.push('-B', String(before));
	if (after !== undefined) args.push('-A', String(after));
	if (context !== undefined) args.push('-C', String(context));

	if (typeof input.type === 'string' && input.type) args.push('-t', input.type);
	if (typeof input.glob === 'string' && input.glob) args.push('-g', input.glob);

	// The built-in defaults to files_with_matches, tgrep to content.
	const mode = input.output_mode;
	if (mode === 'files_with_matches' || mode === undefined) args.push('-l');
	else if (mode === 'count') args.push('-c');
	else if (mode !== 'content') return undefined;

	args.push('--', pattern);
	args.push(typeof input.path === 'string' && input.path ? input.path : '.');
	return args;
}

function countNewlines(text: string): number {
	let count = 0;
	for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') count += 1;
	return count;
}

function render(output: string, offset: number, limit: number): string {
	const lines = output.split('\n');
	const page = lines.slice(offset, limit > 0 ? offset + limit : undefined);
	const body = page
		.map(line => (line.startsWith('./') ? line.slice(2) : line))
		.join('\n');
	if (page.length >= lines.length - offset) return body;
	return `${body}\n\n[tgrep: output truncated at ${limit} lines - narrow the pattern, raise head_limit, or use offset]`;
}

async function run(
	cmd: ModApi,
	args: string[],
	cwd: string,
	signal: AbortSignal | undefined
): Promise<Run> {
	let stdout = '';
	let stderr = '';
	const {code} = await cmd.process.spawn({
		command: 'tgrep',
		args,
		cwd,
		signal,
		onOutput: (chunk, stream) => {
			if (stream === 'stdout') stdout += chunk;
			else if (stderr.length < STDERR_CAP) stderr += chunk;
		},
	});
	return {stdout, stderr, code};
}

async function serverIsLive(
	cmd: ModApi,
	cwd: string,
	signal: AbortSignal | undefined
): Promise<boolean> {
	// Never let a wedged server hang the grep call.
	const timeout = AbortSignal.timeout(2_000);
	try {
		const {stdout} = await run(
			cmd,
			['status', '.'],
			cwd,
			signal ? AbortSignal.any([signal, timeout]) : timeout
		);
		return /^server status for/im.test(stdout);
	} catch {
		return false;
	}
}

export default function (cmd: ModApi): void {
	cmd.addFlag('tgrep-no-index', {
		type: 'boolean',
		description:
			'Search the working tree instead of the tgrep index (always fresh, much slower)',
	});

	cmd.hooks({
		beforeToolCall: async ({toolName, input}, ctx) => {
			if (toolName !== 'grep') return undefined;

			const cwd = ctx?.cwd;
			if (!cwd || !existsSync(join(cwd, '.tgrep', 'meta.json'))) {
				return undefined;
			}

			const noIndex = cmd.getFlag('tgrep-no-index') === true;
			// A scan is always fresh, so only the indexed path needs a live server.
			if (!noIndex) {
				if (!existsSync(join(cwd, '.tgrep', 'serve.json'))) return undefined;
				if (!(await serverIsLive(cmd, cwd, ctx?.signal))) return undefined;
			}

			const args = buildArgs(input as Record<string, unknown>, noIndex);
			if (!args) return undefined;

			const offset = asNumber(input.offset) ?? 0;
			const limit = asNumber(input.head_limit) ?? DEFAULT_HEAD_LIMIT;
			// One line past the page tells us whether the output was truncated.
			const stopAt =
				limit > 0 ? offset + limit + 1 : Number.POSITIVE_INFINITY;

			const controller = new AbortController();
			const forwardAbort = () => controller.abort();
			ctx?.signal?.addEventListener('abort', forwardAbort, {once: true});
			const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

			let buffer = '';
			let stderr = '';
			let lineCount = 0;
			let stoppedEarly = false;

			try {
				const {code} = await cmd.process.spawn({
					command: 'tgrep',
					args,
					cwd,
					signal: controller.signal,
					onOutput: (chunk, stream) => {
						if (stoppedEarly) return;
						if (stream !== 'stdout') {
							if (stderr.length < STDERR_CAP) stderr += chunk;
							return;
						}
						buffer += chunk;
						lineCount += countNewlines(chunk);
						if (lineCount >= stopAt) {
							stoppedEarly = true;
							controller.abort();
						}
					},
				});

				// The server died between the probe and the query: the answer came from
				// a snapshot, so let the built-in grep handle it instead.
				if (/falling back to local index/i.test(stderr)) return undefined;

				if (!stoppedEarly) {
					if (code === 1) {
						return {result: [{type: 'text', text: 'No matches found'}]};
					}
					if (code !== 0) return undefined;
				}
			} catch {
				if (!stoppedEarly) return undefined;
			} finally {
				clearTimeout(timer);
				ctx?.signal?.removeEventListener('abort', forwardAbort);
			}

			const output = buffer.trimEnd();
			if (!output) return undefined;
			return {result: [{type: 'text', text: render(output, offset, limit)}]};
		},
	});
}
