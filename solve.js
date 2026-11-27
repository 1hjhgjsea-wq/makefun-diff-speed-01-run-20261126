// A faster drop-in for makefun-diff 1.0.0 (MIT).
//
// run(input) returns exactly makefun-diff 1.0.0's diffPatch({ old, new }):
// lines cut after every "\n" only, the common prefix kept, then the common
// suffix of what is left, then Myers's greedy search between them that keeps
// on each diagonal the path reaching furthest into the old text and, on a
// tie, takes the deletion's path (jsdiff takes the insertion's), never moves
// past either text's end, prunes no edge diagonal, and follows every run of
// equal lines as far as it goes; the first path to reach both ends is the
// script. The patch is rendered exactly as makefun-diff renders it.
//
// Speed comes from doing the same search with no per-step allocation:
// lines are hashed once to small integer ids, the search runs on Int32Array
// line ids with one small typed-array V per edit distance d (kept for the
// backtrack), and the patch is rendered from the backtracked runs.

const KEEP = 0;
const DELETE = 1;
const INSERT = 2;

/** A line as the patch writes it: its op, the line, a newline, and "%" on a line of its own when it had none. */
function written(op, line) {
  return line.endsWith('\n') ? op + line : op + line + '\n%\n';
}

/**
 * Tokenize a text into lines (each keeping its "\n", the last one without
 * when the text does not end in one) and map each distinct line to a small
 * integer id shared by both texts of the case, so line equality in the
 * search is one integer comparison. Returns the ids as an Int32Array and
 * appends the line strings to `lines` (kept for rendering the patch).
 */
function tokenize(text, map, lines) {
  const ids = [];
  let start = 0;
  const len = text.length;
  while (start < len) {
    const nl = text.indexOf('\n', start);
    let line;
    if (nl === -1) {
      line = text.slice(start);
      start = len;
    } else {
      line = text.slice(start, nl + 1);
      start = nl + 1;
    }
    lines.push(line);
    let id = map.get(line);
    if (id === undefined) {
      id = map.size;
      map.set(line, id);
    }
    ids.push(id);
  }
  return Int32Array.from(ids);
}

/**
 * Myers's greedy search on the trimmed id arrays A[0..n) and B[0..m).
 * Returns { d, k, vall, SENT }: the edit distance d, the final diagonal
 * k = n - m, and vall, one flat array holding every distance's V, V(e)
 * at vall[e * e + j] (j = (k + e) / 2, SENT where no path reached that
 * diagonal). Identical in every choice to makefun-diff's search: deletion
 * when its x reaches at least as far as the insertion's, a deletion only
 * while an old line is left to delete, an insertion only while a new line
 * is left to insert, diagonals scanned from -d upward, and the first path
 * to reach both ends wins.
 */
function myers(A, B, n, m) {
  const small = n < 65535 && m < 65535;
  const Arr = small ? Uint16Array : Int32Array;
  const SENT = small ? 0xffff : -1;
  // One flat array, grown by doubling: V(e) lives at e * e + j.
  let capD = 1024;
  let vall = new Arr((capD + 1) * (capD + 1));
  const grow = (d) => {
    while (capD < d) {
      const next = new Arr((capD * 2 + 1) * (capD * 2 + 1));
      next.set(vall);
      vall = next;
      capD *= 2;
    }
  };
  // d = 0: the snake from the start.
  let x = 0;
  let y = 0;
  while (x < n && y < m && A[x] === B[y]) {
    x++;
    y++;
  }
  vall[0] = x;
  if (x >= n && y >= m) return { d: 0, k: 0, vall, SENT };
  for (let d = 1; d <= n + m; d++) {
    grow(d);
    const vpBase = (d - 1) * (d - 1);
    const vBase = d * d;
    // j = 0 (k = -d): only the insertion from diagonal -d + 1 can reach it.
    {
      const k = -d;
      const xp = vall[vpBase];
      if (xp !== SENT && xp - 1 - k < m) {
        let xn = xp;
        let yn = xn - k;
        while (xn < n && yn < m && A[xn] === B[yn]) {
          xn++;
          yn++;
        }
        vall[vBase] = xn;
        if (xn >= n && yn >= m) return { d, k, vall, SENT };
      } else {
        vall[vBase] = SENT;
      }
    }
    for (let j = 1; j < d; j++) {
      const k = -d + 2 * j;
      // Deletion's candidate: one old line past diagonal k - 1.
      const xpDel = vall[vpBase + j - 1];
      // Insertion's candidate: diagonal k + 1, one new line on.
      const xpIns = vall[vpBase + j];
      let xDel = -1;
      let xIns = -1;
      if (xpDel !== SENT && xpDel < n) xDel = xpDel + 1;
      if (xpIns !== SENT && xpIns - 1 - k < m) xIns = xpIns;
      if (xDel === -1 && xIns === -1) {
        vall[vBase + j] = SENT;
        continue;
      }
      // Furthest into the old text wins; the deletion wins a tie.
      let xn = xDel !== -1 && (xIns === -1 || xDel >= xIns) ? xDel : xIns;
      let yn = xn - k;
      while (xn < n && yn < m && A[xn] === B[yn]) {
        xn++;
        yn++;
      }
      vall[vBase + j] = xn;
      if (xn >= n && yn >= m) return { d, k, vall, SENT };
    }
    // j = d (k = d): only the deletion from diagonal d - 1 can reach it.
    {
      const k = d;
      const xp = vall[vpBase + d - 1];
      if (xp !== SENT && xp < n) {
        let xn = xp + 1;
        let yn = xn - k;
        while (xn < n && yn < m && A[xn] === B[yn]) {
          xn++;
          yn++;
        }
        vall[vBase + d] = xn;
        if (xn >= n && yn >= m) return { d, k, vall, SENT };
      } else {
        vall[vBase + d] = SENT;
      }
    }
  }
  throw new Error('makefun-diff: the search ended without reaching both ends');
}

/**
 * Walk the search back from (n, m) at distance d to the start, rebuilding
 * the edit script's runs in order. Each step recomputes the same
 * deletion/insertion choice the forward search made from vs[d - 1], takes
 * the snake between the edit and the point it reached, then the single edit.
 */
function backtrackRuns(A, B, n, m, d, kEnd, vall, SENT) {
  const rev = []; // runs in reverse order: { kind, count }
  const push = (kind, count) => {
    if (count <= 0) return;
    const last = rev[rev.length - 1];
    if (last !== undefined && last.kind === kind) last.count += count;
    else rev.push({ kind, count });
  };
  let x = n;
  let y = m;
  let k = kEnd;
  for (let dd = d; dd >= 1; dd--) {
    const vpBase = (dd - 1) * (dd - 1);
    const j = (k + dd) >> 1;
    let xDel = -1;
    let xIns = -1;
    if (j - 1 >= 0) {
      const xp = vall[vpBase + j - 1];
      if (xp !== SENT && xp < n) xDel = xp + 1;
    }
    if (j <= dd - 1) {
      const xp = vall[vpBase + j];
      if (xp !== SENT && xp - 1 - k < m) xIns = xp;
    }
    let del;
    if (xDel !== -1 && (xIns === -1 || xDel >= xIns)) del = true;
    else if (xIns !== -1) del = false;
    else throw new Error('makefun-diff: backtrack found no path');
    // The point right after the edit, before the snake that reached (x, y).
    const xe = del ? xDel : xIns;
    const ye = xe - k;
    push(KEEP, x - xe);
    if (del) {
      push(DELETE, 1);
      x = xe - 1;
      y = ye;
      k = k - 1;
    } else {
      push(INSERT, 1);
      x = xe;
      y = ye - 1;
      k = k + 1;
    }
  }
  push(KEEP, x); // the d = 0 snake from the start
  rev.reverse();
  return rev;
}

/** makefun-diff 1.0.0's answer for one case's input. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const map = new Map();
  const aLines = [];
  const bLines = [];
  const aIds = tokenize(input.old, map, aLines);
  const bIds = tokenize(input.new, map, bLines);
  const n = aIds.length;
  const m = bIds.length;

  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && aIds[prefix] === bIds[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && aIds[n - 1 - suffix] === bIds[m - 1 - suffix]) suffix++;

  const nMid = n - prefix - suffix;
  const mMid = m - prefix - suffix;
  const mid = myers(
    aIds.subarray(prefix, n - suffix),
    bIds.subarray(prefix, m - suffix),
    nMid,
    mMid,
  );
  const runs = backtrackRuns(
    aIds.subarray(prefix, n - suffix),
    bIds.subarray(prefix, m - suffix),
    nMid,
    mMid,
    mid.d,
    mid.k,
    mid.vall,
    mid.SENT,
  );
  // Stitch the prefix and suffix keeps onto the middle runs, merging keeps.
  const all = [];
  const pushRun = (kind, count) => {
    if (count <= 0) return;
    const last = all[all.length - 1];
    if (last !== undefined && last.kind === kind) last.count += count;
    else all.push({ kind, count });
  };
  pushRun(KEEP, prefix);
  for (const r of runs) pushRun(r.kind, r.count);
  pushRun(KEEP, suffix);

  // The change runs: each a stretch of deletions and insertions between two kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const r of all) {
    if (r.kind === KEEP) {
      o += r.count;
      p += r.count;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r.kind === DELETE) {
      c.dels += r.count;
      o += r.count;
      deleted += r.count;
    } else {
      c.ins += r.count;
      p += r.count;
      inserted += r.count;
    }
  }

  // The hunks: change runs at most 2 * 3 kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * 3) h.push(c);
    else hunks.push([c]);
  }
  const out = [`makefun-diff/1 old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - 3);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(3, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written('=', aLines[at]));
      for (let i = 0; i < c.dels; i++) out.push(written('-', aLines[c.o + i]));
      for (let i = 0; i < c.ins; i++) out.push(written('+', bLines[c.p + i]));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written('=', aLines[at]));
  }
  return out.join('');
}
