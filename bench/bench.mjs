#!/usr/bin/env node
// Compares ripgrep with tgrep on the working tree it is pointed at.
//
//   node bench/bench.mjs <root> [--runs N] [--slow]
//
// Measures the best of N runs for each pattern shape and reports whether the two
// engines return the same number of matching files. `--slow` adds a pattern with no
// literal trigrams, which forces tgrep to scan every indexed file and is slow by
// design - it is the case where tgrep loses to ripgrep.

import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

const argv = process.argv.slice(2);
const root = resolve(argv.find(a => !a.startsWith('--')) ?? '.');
const runs = Number(argv[argv.indexOf('--runs') + 1]) || 3;
const slow = argv.includes('--slow');

function have(command) {
	try {
		execFileSync(command, ['--version'], {stdio: 'ignore'});
		return true;
	} catch {
		return false;
	}
}

if (!have('rg') || !have('tgrep')) {
	console.error('bench: needs both `rg` and `tgrep` on PATH');
	process.exit(1);
}

function run(command, args) {
	try {
		return execFileSync(command, args, {
			cwd: root,
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024,
		});
	} catch (error) {
		// grep exits 1 when there are no matches, which is not a failure here.
		if (error.status === 1) return '';
		throw error;
	}
}

function best(command, args) {
	// Warm the page cache and tgrep's query cache before timing.
	try {
		execFileSync(command, args, {cwd: root, stdio: 'ignore'});
	} catch {
		// no matches is fine
	}
	let fastest = Number.POSITIVE_INFINITY;
	for (let i = 0; i < runs; i += 1) {
		const started = process.hrtime.bigint();
		// Output is discarded: this measures the search, not the pipe.
		execFileSync(command, args, {cwd: root, stdio: 'ignore'});
		const ms = Number(process.hrtime.bigint() - started) / 1e6;
		if (ms < fastest) fastest = ms;
	}
	return fastest;
}

function files(command, pattern) {
	const out = run(command, ['-l', '--', pattern, '.']);
	return out.split('\n').filter(Boolean).length;
}

function status() {
	try {
		const out = execFileSync('tgrep', ['status', '.'], {
			cwd: root,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		return /^server status for/im.test(out) ? 'running' : 'not running';
	} catch {
		return 'unknown';
	}
}

function fmt(ms) {
	return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

const patterns = [
	['literal, selective', 'TODO'],
	['literal, broad', 'function'],
];

if (slow) patterns.push(['regex, no literal trigrams', '[0-9]{3,}']);

const meta = join(root, '.tgrep', 'meta.json');
const indexed = existsSync(meta)
	? JSON.parse(readFileSync(meta, 'utf8')).num_files
	: 0;

console.log(`root:    ${root}`);
console.log(`index:   ${indexed ? `${indexed} files` : 'none (tgrep will scan)'}`);
console.log(`server:  ${status()}`);
console.log(`runs:    ${runs} (best of)\n`);
console.log('| pattern | shape | ripgrep | tgrep | speedup | same files |');
console.log('|---|---|---:|---:|---:|---:|');

for (const [shape, pattern] of patterns) {
	const rg = best('rg', ['-n', '--', pattern, '.']);
	const tg = best('tgrep', ['-n', '--', pattern, '.']);
	const rgFiles = files('rg', pattern);
	const tgFiles = files('tgrep', pattern);
	const ratio = tg > 0 ? rg / tg : 0;
	console.log(
		`| \`${pattern}\` | ${shape} | ${fmt(rg)} | ${fmt(tg)} | ${ratio.toFixed(1)}x | ${rgFiles === tgFiles ? 'yes' : `no (${rgFiles} vs ${tgFiles})`} |`
	);
}

console.log(
	'\nSame-file counts compare `-l` output; a mismatch usually means an ignore-rule\n' +
		'or hidden-file difference between the two walkers, not a missed match.'
);
