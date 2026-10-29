#!/usr/bin/env node
// Measures the mod's own `grep` interception, without running Command Code.
//
//   node bench/mod-bench.mjs <root> [--runs N] [--slow]
//
// Registers the mod against a minimal ModApi that spawns real processes, then times the
// result the model would see for each grep shape. `rg` is timed with the same output
// discarded, as an engine-level reference.

import {execFileSync, spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const argv = process.argv.slice(2);
const root = resolve(argv.find(a => !a.startsWith('--')) ?? '.');
const runs = Number(argv[argv.indexOf('--runs') + 1]) || 3;
const slow = argv.includes('--slow');

const mod = (
	await import(pathToFileURL(resolve('./index.ts')).href)
).default;

function makeCmd(noIndex) {
	let hooks;
	mod({
		addFlag() {},
		getFlag: () => noIndex,
		hooks: h => {
			hooks = h;
		},
		process: {
			spawn: ({command, args, cwd, signal, onOutput}) =>
				new Promise((done, fail) => {
					const child = spawn(command, args, {cwd, signal});
					child.stdout.on('data', d => onOutput(d.toString(), 'stdout'));
					child.stderr.on('data', d => onOutput(d.toString(), 'stderr'));
					child.on('error', fail);
					child.on('close', code =>
						signal?.aborted ? fail(new Error('aborted')) : done({code})
					);
				}),
		},
	});
	return hooks.beforeToolCall;
}

function rgBest(pattern) {
	try {
		execFileSync('rg', ['-n', '--', pattern, '.'], {
			cwd: root,
			stdio: 'ignore',
		});
	} catch {
		// no matches is fine
	}
	let fastest = Number.POSITIVE_INFINITY;
	for (let i = 0; i < runs; i += 1) {
		const started = process.hrtime.bigint();
		execFileSync('rg', ['-n', '--', pattern, '.'], {cwd: root, stdio: 'ignore'});
		const ms = Number(process.hrtime.bigint() - started) / 1e6;
		if (ms < fastest) fastest = ms;
	}
	return fastest;
}

async function modBest(hook, input) {
	// One untimed call so the liveness probe and tgrep cache are warm.
	await hook({toolName: 'grep', input}, {cwd: root, signal: undefined});
	let fastest = Number.POSITIVE_INFINITY;
	let last;
	for (let i = 0; i < runs; i += 1) {
		const started = process.hrtime.bigint();
		last = await hook({toolName: 'grep', input}, {cwd: root, signal: undefined});
		const ms = Number(process.hrtime.bigint() - started) / 1e6;
		if (ms < fastest) fastest = ms;
	}
	return {ms: fastest, intercepted: last !== undefined};
}

function fmt(ms) {
	return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

const hook = makeCmd(false);
const cases = [
	['literal, selective', 'TODO', {pattern: 'TODO', output_mode: 'content'}],
	[
		'literal, broad',
		'function',
		{pattern: 'function', output_mode: 'content'},
	],
	[
		'literal, no matches',
		'qzxjkvv',
		{pattern: 'qzxjkvv', output_mode: 'content'},
	],
];

if (slow) {
	cases.push([
		'regex, no literal trigrams',
		'[0-9]{3,}',
		{pattern: '[0-9]{3,}', output_mode: 'content'},
	]);
}

console.log(`root:  ${root}`);
console.log(`index: ${existsSync(`${root}/.tgrep/meta.json`) ? 'present' : 'none'}`);
console.log(`runs:  ${runs} (best of)\n`);
console.log('| query | shape | rg (full output) | mod (grep tool) | speedup |');
console.log('|---|---|---:|---:|---:|');

for (const [shape, label, input] of cases) {
	const rg = rgBest(label);
	const {ms, intercepted} = await modBest(hook, input);
	const ratio = ms > 0 ? rg / ms : 0;
	console.log(
		`| \`${label}\` | ${shape} | ${fmt(rg)} | ${fmt(ms)}${intercepted ? '' : ' (fell back)'} | ${ratio.toFixed(1)}x |`
	);
}

console.log(
	'\n"rg (full output)" discards output and runs the whole search. "mod" is the tool result\n' +
		'the model receives, capped at the default head_limit of 250 lines. A row marked\n' +
		'"fell back" means the mod declined and the built-in grep would run instead.'
);
