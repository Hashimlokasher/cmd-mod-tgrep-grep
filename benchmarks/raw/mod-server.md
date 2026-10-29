root:  /path/to/tree
index: present
runs:  5 (best of)

| query | shape | rg (full output) | mod (grep tool) | speedup |
|---|---|---:|---:|---:|
| `TODO` | literal, selective | 3.07s | 31ms | 100.1x |
| `function` | literal, broad | 3.37s | 163ms | 20.6x |
| `qzxjkvv` | literal, no matches | 3.01s | 16ms | 190.8x |

"rg (full output)" discards output and runs the whole search. "mod" is the tool result
the model receives, capped at the default head_limit of 250 lines. A row marked
"fell back" means the mod declined and the built-in grep would run instead.
