# cmd-mod-tgrep-grep

Routes Command Code's built-in `grep` tool through [tgrep](https://github.com/microsoft/tgrep)'s
trigram index. The model keeps calling `grep` with the same parameters; tgrep answers it.

On a 124k-file working tree, a selective search that costs ripgrep ~2.9s comes back in ~30ms.

## How it works

The mod registers a `beforeToolCall` hook. When the tool is `grep`, it translates the built-in
parameters into tgrep's CLI and returns `result`, which answers the call without running the
built-in tool. Anything it cannot do safely returns `undefined`, and the normal ripgrep-backed
grep runs unchanged.

Parameter mapping worth knowing about:

- The built-in defaults `output_mode` to `files_with_matches` while tgrep defaults to content,
  so `-l` is added when the parameter is absent.
- tgrep omits line numbers unless `-n` is passed, despite its help calling that the default.
- `head_limit` and `offset` are enforced by aborting the stream once `offset + limit + 1` lines
  have arrived, so a query matching 285k lines still returns in ~200ms instead of streaming
  everything into memory.
- A single-file target omits the filename, matching ripgrep.

## Requirements

1. **tgrep 1.2.5 or newer on `PATH`** - see [Installing tgrep](#installing-tgrep).
2. **An index** at the session root: `tgrep index .` (creates `.tgrep/`).
3. **A running server**: `tgrep serve .`

Step 3 is not optional, and it is not a performance tweak.

## Installing tgrep

The mod does not install tgrep. Install it once per machine, then index each tree you want
accelerated. Indexing and serving commands are identical on every platform; only installation
differs.

### macOS

```bash
brew install tgrep
```

The Homebrew bottle covers Intel and Apple Silicon.

### Linux

Homebrew, if you have it:

```bash
brew install tgrep
```

Otherwise use a release binary (`x86_64` shown; on ARM64 use `aarch64-unknown-linux-musl`):

```bash
tmpdir="$(mktemp -d)"
gh release download --repo microsoft/tgrep -p '*x86_64-unknown-linux-musl.tar.gz' -D "$tmpdir"
tar xzf "$tmpdir"/tgrep-*-x86_64-unknown-linux-musl.tar.gz -C "$tmpdir"
install -Dm755 "$tmpdir/tgrep" "$HOME/.local/bin/tgrep"
rm -rf "$tmpdir"
```

Make sure `$HOME/.local/bin` is on `PATH`.

### Windows

PowerShell (`x86_64` shown; on ARM64 use `aarch64-pc-windows-msvc.zip`):

```powershell
$dest = "$HOME\.local\bin"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$tmp = Join-Path $env:TEMP ("tgrep-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
gh release download --repo microsoft/tgrep -p '*x86_64-pc-windows-msvc.zip' -D $tmp
Expand-Archive -LiteralPath (Get-ChildItem $tmp -Filter *.zip | Select-Object -First 1).FullName `
    -DestinationPath $dest -Force
Remove-Item $tmp -Recurse
[Environment]::SetEnvironmentVariable("Path",
    [Environment]::GetEnvironmentVariable("Path", "User") + ";$dest", "User")
```

Open a new terminal so the `PATH` change applies, then check `tgrep --version`. The upstream
instructions extract to `$HOME\.cargo\bin` instead; either location works as long as it is on
`PATH`. Without `gh`, download the zip from the
[releases page](https://github.com/microsoft/tgrep/releases) and add the extracted folder to
`PATH` yourself.

### WSL

Install the Linux binary inside the distribution and index paths in the Linux filesystem
(`/home/...`). Walking `/mnt/c` works but is much slower, and the native watcher cannot give
complete coverage across the Windows boundary - either index inside WSL, or run tgrep on the
Windows side for Windows paths.

### From source

```bash
git clone https://github.com/microsoft/tgrep.git
cd tgrep
cargo install --path tgrep-cli --locked
```

### Index and serve

```bash
cd /path/to/repo
tgrep index .     # add --no-require-git for folders outside a git repository
tgrep serve .     # keep this running
```

Windows, PowerShell or `cmd` - same arguments:

```powershell
cd C:\src\repo
tgrep index .
tgrep serve .
```

Add `.tgrep/` to the repository's `.gitignore`: it is generated build output and should not be
committed.

### Keeping the server running

`tgrep serve .` is a foreground process. The mod only requires that `tgrep status .` answers, so
any supervisor works.

**macOS** - leave it in a terminal or tmux tab, or add a launchd agent.

**Linux** - a systemd user unit:

```ini
# ~/.config/systemd/user/tgrep.service
[Unit]
Description=tgrep server
[Service]
WorkingDirectory=%h/src/repo
ExecStart=%h/.local/bin/tgrep serve .
Restart=on-failure
[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now tgrep
```

**Windows** - a task that starts at logon:

```powershell
schtasks /create /tn tgrep /sc onlogon /tr "\"$HOME\.local\bin\tgrep.exe\" serve C:\src\repo"
```

Adjust the paths, and run the task in a hidden window if the console is unwelcome.

## Why the server is required

Without a server, tgrep answers from an on-disk snapshot, and a snapshot silently misses
everything written since it was built. Measured directly: create a file, then search for its
contents.

```
$ printf 'token zzstaleprobe123\n' > tgrep-staleness-probe.txt
$ tgrep -n -- zzstaleprobe123 .     # exit 1, no output
$ rg -n -- zzstaleprobe123 .        # ./tgrep-staleness-probe.txt:1:token ...
```

A grep tool that answers "No matches found" for a file that exists is worse than a slow one,
so the mod checks before it answers:

| gate | passed when |
|---|---|
| `.tgrep/meta.json` exists | an index was built for the session root |
| `.tgrep/serve.json` exists | a server was started |
| `tgrep status .` reports `Server status for` | the server answers right now (2s cap) |
| query stderr has no `falling back to local index` | the server did not die mid-query |

Any failure means the mod does nothing and the built-in grep answers. It fails closed: if tgrep
changes its status wording, you lose the speedup, never correctness.

With the server up, a new file is searchable in about a second, and the index is reconciled on
startup (0.5s when clean, ~3s after a large change).

## Benchmarks

Full methodology, raw output, and limitations: [BENCHMARKS.md](./BENCHMARKS.md). Summary,
measured on an M1 Max with a warm cache over 124,465 files (best of 5, server live):

| query | shape | ripgrep (full search) | this mod | speedup |
|---|---|---:|---:|---:|
| `TODO` | literal, selective | 3.07s | 31ms | 100x |
| `function` | literal, broad | 3.37s | 163ms | 21x |
| `qzxjkvv` | literal, absent | 3.01s | 16ms | 191x |

The broad row is the interesting one: with full output, tgrep is only 1.2x faster than ripgrep
(2.83s vs 3.31s). The mod wins by refusing to materialise more output than the caller asked for.

Two costs to know about:

- A pattern with no literal trigrams (`\d{9,}`) takes 40.5s against ripgrep's 3.0s, because the
  index cannot narrow it. The 30s cap then hands the query to the built-in.
- No server means no acceleration: the disk snapshot answers in 250ms but can be stale, and a
  fresh scan takes 7.85s versus ripgrep's 3.1s.

The mod therefore needs both an index and a running server, and is inert without them.

## Install

```bash
cmd mods add Hashimlokasher/cmd-mod-tgrep-grep   # GitHub
cmd mods add ./mods/tgrep-grep                  # from a checkout
cmd --mod ./mods/tgrep-grep                     # one session, no install
```

Then build an index and start a server in the project you want accelerated:

```bash
tgrep index .
tgrep serve .
```

`cmd mods list` should show it, and `cmd mods inspect` reports what it can reach:

```
hooks:     beforeToolCall
registers: flag
reaches:   streams process output (cmd.process.spawn), filesystem (fs)
```

## Verifying it is active

Ask for a search that overflows the page limit, for example `pattern: function`,
`output_mode: content`, `head_limit: 1`. When the mod answers, the result ends with:

```
[tgrep: output truncated at 1 lines - narrow the pattern, raise head_limit, or use offset]
```

When the built-in answers instead, you get its own pagination note
(`[Showing results with pagination = limit: 1]`). Same for tool results in
`~/.commandcode/projects/<slug>/<session>.jsonl`.

## Flags and fallbacks

| situation | behavior |
|---|---|
| no `.tgrep/meta.json` | built-in grep |
| no server, or it does not answer | built-in grep |
| server dies mid-query | result discarded, built-in grep |
| invalid regex (tgrep exits 2) | built-in grep |
| missing path | built-in grep |
| query exceeds 30s | built-in grep |
| `--mod-option tgrep-no-index=true` | scans the tree instead of the index (fresh, slow) |

The mod only applies to sessions rooted where the index lives. Sessions started in a subdirectory
without its own `.tgrep/` fall back to ripgrep, as do sessions in other projects.

## Notes

- Semantics follow tgrep: `.gitignore` is respected, hidden files are skipped, `-l`/`-c`/`-n` map
  onto the built-in's output modes.
- A stale-by-a-second index is still possible while the watcher catches up; the server reconciles
  continuously, and the guard only guarantees a server is answering, not that it has finished
  every write.
- The mod is TypeScript loaded directly by Command Code, so it has no build step and no runtime
  dependencies. `@commandcode/harness` is a type-only import resolved by the host; it is not
  published to npm.

## License

MIT.

## Distribution

This repository is the source; there is no npm package. Install with
`cmd mods add Hashimlokasher/cmd-mod-tgrep-grep`.

Listing it on the mods hub means adding one entry to `mods/registry.json` in
[CommandCodeAI/command-code](https://github.com/CommandCodeAI/command-code):

```json
{
	"name": "tgrep-grep",
	"source": "Hashimlokasher/cmd-mod-tgrep-grep",
	"description": "Routes the built-in grep tool through tgrep's trigram index - 100x faster selective searches on large trees, with automatic fallback to ripgrep.",
	"author": {"name": "Hashim", "github": "Hashimlokasher"},
	"repo": "https://github.com/Hashimlokasher/cmd-mod-tgrep-grep",
	"kinds": ["hook", "flag"],
	"tags": ["search", "grep", "performance", "tgrep"],
	"addedAt": "2026-10-29"
}
```

Maintainers review the published code; the hub picks up a merged entry within about 15 minutes.

