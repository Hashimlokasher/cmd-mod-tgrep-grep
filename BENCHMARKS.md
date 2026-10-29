# Benchmarks

Every number here was measured on the machine described below with the scripts in `bench/`.
Raw output is committed under `benchmarks/raw/`.

## Environment

| | |
|---|---|
| CPU | Apple M1 Max, 10 cores |
| Memory | 32 GB |
| OS | macOS 27.0.1, arm64 |
| Node | v26.7.0 |
| ripgrep | 15.2.0 (what Command Code's built-in grep uses) |
| tgrep | 1.2.5 |

**Corpus.** A private monorepo workspace: 29 GB on disk, 124,465 indexed files, 513,166 trigrams.
The tgrep index occupies 974 MB (3.4% of the tree). Page cache was warm for every run - these are
warm-cache numbers, not first-touch numbers.

**Method.** Each command is warmed once and then timed N times, keeping the fastest run, because
a single cold run measures the filesystem rather than the search. Output is discarded during
timing so the pipe is not part of the measurement. Two definitional details matter:

- "ripgrep" is a **complete** search: the engine runs to the last match, its output discarded.
- "mod" is the **tool result the model receives**, cut at the default `head_limit` of 250 lines.

The built-in grep tool also stops at its page limit, so the real-world advantage over the
built-in lies between the two tables below. Matching-file counts were compared between engines
for every pattern (`-l` parity) and agreed in all cases.

## 1. As the model sees it

`node bench/mod-bench.mjs /path/to/tree --runs 5`

| query | shape | matching files | ripgrep (full) | this mod | speedup |
|---|---|---:|---:|---:|---:|
| `TODO` | literal, selective | 1,280 | 3.07s | 31ms | 100x |
| `function` | literal, broad | 7,008 | 3.37s | 163ms | 21x |
| `qzxjkvv` | literal, absent | 0 | 3.01s | 16ms | 191x |

The broad-literal row is the one worth understanding. `function` matches 65,004 lines; tgrep can
produce them all but the mod stops at 250, so the answer arrives in 163ms instead of streaming
megabytes. The absent pattern is the cheapest case: the trigram index proves non-membership
without reading file contents.

Per-call overhead includes the liveness probe described in section 4.

## 2. Engine level, full output

`node bench/bench.mjs /path/to/tree --runs 3`

| query | shape | ripgrep | tgrep (server) | speedup |
|---|---|---:|---:|---:|
| `TODO` | literal, selective | 3.37s | 26ms | 130x |
| `function` | literal, broad | 3.31s | 2.83s | 1.2x |

Producing *every* match of a very broad literal is where tgrep gives its advantage back: it still
beats ripgrep slightly here, but 1.2x is not the point. The win comes from two places - a trigram
index that narrows candidate files, and refusing to materialise more output than the caller asked
for.

## 3. Access modes

Same query (`TODO`), three ways of getting an answer from tgrep, plus ripgrep for reference:

| mode | time | note |
|---|---:|---|
| server (`tgrep serve .`) | 26ms | reconciled index, cache warm |
| disk index (no server) | 250ms | snapshot; **misses recent writes** |
| scan (`--no-index`) | 7.85s | always fresh, no index |
| ripgrep (full search) | 3.07-3.37s | always fresh, no index |

This is why the mod requires a server rather than an index. The snapshot is 10x faster than
ripgrep and still wrong; the scan is correct and slower than ripgrep. Only the server is both
fast and current.

## 4. What the guard costs

The mod asks `tgrep status .` before answering, and only proceeds if the reply says
`Server status for` - a real round trip to the daemon, not a check of the `serve.json` file.

| state | time |
|---|---:|
| server live | 0.00s (under 10ms, best of 3) |
| server gone | 0.07-0.08s (only when a stale `serve.json` is left behind) |

With no `serve.json` at all, the mod returns before spawning anything and the cost is zero.

## 5. Freshness

The reason the guard exists. A file is created and searched for immediately.

| state | `tgrep` result | `rg` result |
|---|---|---|
| index only, no server | exit 1, **no output** | `./tgrep-staleness-probe.txt:1:token …` |
| server running | found in **0.01s** | found |

An index without a server answers "no matches" for a file that exists. The guard means the mod
never serves that answer.

Server startup and reconciliation, measured from the serve log:

| step | time |
|---|---:|
| open 124k-file index, serve ready | 0.63s |
| stale check walk | 0.41-0.44s |
| publish delta (1-2 changed files) | 3.2-3.4s |
| publish delta (51 changed, 1 new, 15 deleted) | 3.2s |

## 6. The case where tgrep loses

Patterns with no run of three literal characters cannot be narrowed by the index, so tgrep reads
every indexed file and applies the regex itself.

| query | ripgrep | tgrep (server) | ratio |
|---|---:|---:|---:|
| `\d{9,}` | 2.99s | 40.50s | 13.5x slower |

The mod caps a query at 30s and then returns `undefined`, so the built-in grep answers: worst case
is about 30s followed by a normal ripgrep run. Literal anchors in the pattern avoid this class
entirely.

## 7. Reproduce

```bash
git clone https://github.com/Hashimlokasher/cmd-mod-tgrep-grep
cd cmd-mod-tgrep-grep

node bench/bench.mjs /path/to/tree --runs 3          # engines, full output
node bench/mod-bench.mjs /path/to/tree --runs 5      # the hook, as the model sees it
node bench/bench.mjs /path/to/tree --slow            # adds the no-trigram case (~40s)
```

Point them at a tree with an index (`tgrep index .`) and a running server (`tgrep serve .`) for
the accelerated numbers; stop the server to measure the snapshot path instead. Use `--runs` to
trade time for stability.

## Limitations

- One machine, one corpus, warm cache. Absolute times do not transfer; ratios do, roughly,
  as long as the tree is large enough that index lookup is not dominated by process startup.
- Measured on macOS 27 / arm64. Windows (NTFS, Defender) and Linux produce different absolute
  latencies; the ordering of the access modes in section 3 should hold, the numbers will not.
- Paths in `benchmarks/raw/` are redacted; the measurements were taken against the private tree
  described above.
- The ripgrep baseline is a full search. Command Code's built-in grep may stop earlier, so
  the real-world speedup is lower than the tables show - most of the gap survives because the
  built-in must still walk the whole tree.
- Matching-file parity was checked, not match ordering or line content. Both tools respect
  `.gitignore` and skip hidden files, but their walkers are not identical.
- tgrep's index is a trigram index: selectivity of the pattern, not tree size alone, decides the
  speedup. Section 6 is the boundary of that.
