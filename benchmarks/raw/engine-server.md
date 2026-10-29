root:    /path/to/tree
index:   124465 files
server:  running
runs:    3 (best of)

| pattern | shape | ripgrep | tgrep | speedup | same files |
|---|---|---:|---:|---:|---:|
| `TODO` | literal, selective | 3.37s | 26ms | 129.8x | yes |
| `function` | literal, broad | 3.31s | 2.83s | 1.2x | yes |

Same-file counts compare `-l` output; a mismatch usually means an ignore-rule
or hidden-file difference between the two walkers, not a missed match.
