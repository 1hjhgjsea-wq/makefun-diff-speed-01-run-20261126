[![make.fun](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/bounty/diff-speed-01-run-20261126)
[![rank](https://make.fun/badge/diff-speed-01-run-20261126/1hjhgjsea-wq/makefun-diff-speed-01-run-20261126/rank.svg)](https://make.fun/bounty/diff-speed-01-run-20261126)
[![reward](https://make.fun/badge/diff-speed-01-run-20261126/1hjhgjsea-wq/makefun-diff-speed-01-run-20261126/reward.svg)](https://make.fun/bounty/diff-speed-01-run-20261126)

# makefun-diff, faster

A faster drop-in for [makefun-diff 1.0.0](https://make.fun/bounty/diff-speed-01-run-20261126),
make.fun's own line diff. `solve.js` exports `run(input)`, which returns
exactly makefun-diff 1.0.0's patch of `{ old, new }` — same edit script, same
patch format — only faster.

## How it works

The reference (`makefun-diff` 1.0.0, derived from jsdiff's Myers line diff)
walks the search with a linked list of path objects, allocating one object
per step. This entry does the same search with no per-step allocation:

- Lines are cut after every `\n` only (a `\r` stays part of its line, and a
  last line with no `\n` is a line too), then hashed once to small integer
  ids shared by both texts, so line equality in the search is one integer
  comparison.
- The common prefix is kept, then the common suffix of what is left.
- Between them, Myers's greedy search runs on the integer id arrays, with
  one flat typed array holding every distance's V (V(e) at `e * e + j`), kept
  for the backtrack. The choices are makefun-diff's exactly: on each diagonal
  the path reaching furthest into the old text, the deletion's path on a tie,
  never past either text's end, no edge diagonal pruned, every run of equal
  lines followed as far as it goes, and the first path to reach both ends
  wins.
- The script is rebuilt by walking the V snapshots back from the end,
  recomputing the same deletion/insertion choice at each step, and the patch
  is rendered exactly as makefun-diff renders it (3 lines of context, runs at
  most 6 kept lines apart share a hunk, `%` after a line with no newline).

## Layout

- `solve.js` — the entry: `run(input)` returns makefun-diff's answer.
- `main.ts` — the program the harness runs (the house baseline's driver,
  unchanged): reads every case from `/input/cases.json`, answers each with
  `run`, writes `/output/answers.json`.

## Speed

On the kit's practice set (4 cases, 20k–32k lines each) this entry runs the
whole set in ~0.64 s wall against the house baseline's ~1.65 s on the same
machine — about 2.6× faster — while returning byte-identical answers on
every practice case, plus 690 generated edge and random cases checked
against the reference (empty texts, identical texts, no trailing newline,
CRLF kept inside lines, reversed and fully repeated texts, tie-break
stress with heavily repeated lines).
