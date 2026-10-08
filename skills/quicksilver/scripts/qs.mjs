#!/usr/bin/env node
// Quicksilver: hand Claude's bulk judgment calls to Jev (TypeSafe System One).
// Zero dependencies. Node 18+.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

// Optional OpenRouter route: --route openrouter or QS_ROUTE=openrouter. Default is the vendor route.
const argv0 = process.argv.slice(2);
const ri = argv0.findIndex((a) => a === '--route' || a.startsWith('--route='));
const OPENROUTER = (ri >= 0 ? (argv0[ri].split('=')[1] ?? argv0[ri + 1]) : process.env.QS_ROUTE) === 'openrouter';
const DECIDE = OPENROUTER ? '/alpha/decisions' : '/v1/systemone';
const API = (process.env.QUICKSILVER_API_BASE || (OPENROUTER ? 'https://openrouter.ai/api' : 'https://api.typesafe.ai')).replace(/\/$/, '');
const HOME = process.env.QUICKSILVER_HOME || path.join(os.homedir(), '.quicksilver');
const CONFIG = path.join(HOME, 'config.json');
const STATS = path.join(HOME, 'stats.json');
const KEY_URL = 'https://console.typesafe.ai';
const PRICE_PER_TOKEN = 0.042 / 1e6;

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit',
  'target', 'vendor', '__pycache__', '.venv', 'venv', 'coverage', '.turbo', '.cache', '.idea', '.vscode']);
const SECRET_RE = /(^|[\/\\])(\.env(\..*)?|.*\.(pem|key|p12|pfx|keystore|jks|crt|cer)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.pypirc|\.netrc|credentials(\.json)?|secrets?\.(json|ya?ml|toml))$/i;
const LOCK_RE = /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|composer\.lock|\.min\.(js|css)|\.map)$/i;

// ---------- args ----------

function parseArgs(argv) {
  const pos = [], flags = {};
  const bools = new Set(['lines', 'json', 'all', 'remove', 'help', 'fast', 'verbose', 'no-collapse', 'no-secrets-guard']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const name = a.slice(2);
      if (bools.has(name) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) flags[name] = true;
      else flags[name] = argv[++i];
    } else pos.push(a);
  }
  return { pos, flags };
}

const die = (msg, code = 1) => { process.stderr.write(`quicksilver: ${msg}\n`); process.exit(code); };
const num = (v, d) => (v === undefined || v === true ? d : Number(v));
const estTokens = (s) => Math.ceil(s.length / 4);
const rel = (p) => path.relative(process.cwd(), p).split(path.sep).join('/') || '.';
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const f2 = (x) => x.toFixed(2);

// ---------- config / stats ----------

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, obj, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', { mode });
  if (mode) try { fs.chmodSync(file, mode); } catch {}
}

function apiKey() {
  if (OPENROUTER) return process.env.OPENROUTER_API_KEY || '';
  return process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY || readJson(CONFIG, {}).api_key || '';
}

function modelName(flags) {
  if (OPENROUTER) return flags.model || process.env.QS_MODEL || process.env.QUICKSILVER_MODEL || 'typesafe/jev-1.13';
  return flags.model || process.env.QUICKSILVER_MODEL || readJson(CONFIG, {}).model || 'jev-latest';
}

function recordStats(run) {
  const s = readJson(STATS, { since: new Date().toISOString(), runs: 0, requests: 0, items: 0, jev_input_tokens: 0, claude_tokens_saved: 0 });
  s.runs += 1;
  s.requests += run.requests;
  s.items += run.items;
  s.jev_input_tokens += run.jevTokens;
  s.claude_tokens_saved += Math.max(0, run.saved);
  try { writeJson(STATS, s); } catch {}
}

// ---------- HTTP ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(method, route, body, { retries = 5 } = {}) {
  const key = apiKey();
  if (!key && OPENROUTER) die('OPENROUTER_API_KEY is not set in the environment', 3);
  if (!key) die(`no Jev API key. Get one at ${KEY_URL}, then run: node qs.mjs setup`, 3);
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch(API + route, {
        method,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      lastErr = `network error: ${e.message}`;
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (res.ok) return res.json();
    const text = await res.text();
    if ((res.status === 401 || res.status === 403) && OPENROUTER) die(`OpenRouter rejected OPENROUTER_API_KEY (${res.status}). Check the key in your environment`, 3);
    if (res.status === 401 || res.status === 403) die(`Jev rejected the API key (${res.status}). Get a new one at ${KEY_URL} and run: node qs.mjs setup`, 3);
    if (res.status === 422 || res.status === 400) die(`Jev rejected the request (${res.status}): ${clip(text, 800)}`, 4);
    lastErr = `HTTP ${res.status}: ${clip(text, 300)}`;
    if (![408, 409, 429, 500, 502, 503, 504, 529].includes(res.status)) break;
    const ra = Number(res.headers.get('retry-after'));
    await sleep(ra > 0 ? ra * 1000 : 500 * 2 ** attempt + Math.random() * 250);
  }
  die(`Jev request failed: ${lastErr}`, 5);
}

async function pool(tasks, n) {
  const out = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => {
    while (next < tasks.length) { const i = next++; out[i] = await tasks[i](); }
  }));
  return out;
}

// ---------- inputs ----------

function gitFiles(dir) {
  try {
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z', '--', '.'], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024,
    });
    return out.split('\0').filter(Boolean).map((f) => path.join(dir, f));
  } catch { return null; }
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!IGNORE_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), acc); }
    else if (e.isFile()) acc.push(path.join(dir, e.name));
  }
  return acc;
}

function expand(spec) {
  if (/[*?[\]{}]/.test(spec)) {
    if (!fs.globSync) die('glob patterns need Node 22+; pass a directory instead');
    return fs.globSync(spec, { exclude: (p) => IGNORE_DIRS.has(path.basename(p)) }).filter((f) => fs.statSync(f).isFile());
  }
  if (!fs.existsSync(spec)) die(`no such file or directory: ${spec}`);
  const st = fs.statSync(spec);
  if (st.isFile()) return [spec];
  const tracked = gitFiles(spec);
  return (tracked?.length ? tracked : walk(spec)).filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
}

function readText(file, maxBytes) {
  const st = fs.statSync(file);
  if (st.size > maxBytes) return null;
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 8192).includes(0)) return null; // binary
  return buf.toString('utf8');
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

// Returns [{id, text, truncated}] plus a list of skipped paths.
function collect(pos, flags) {
  const maxChars = num(flags['max-chars'], 60000);
  const exts = flags.ext ? String(flags.ext).split(',').map((e) => '.' + e.replace(/^\./, '').toLowerCase()) : null;
  const items = [], skipped = [];
  const push = (id, text) => {
    const truncated = text.length > maxChars;
    items.push({ id, text: truncated ? text.slice(0, maxChars) : text, truncated });
  };
  const pushLines = (name, text) => text.split(/\r?\n/).forEach((l, i) => { if (l.trim()) push(`${name}:${i + 1}`, l); });

  if (flags.items) {
    const raw = flags.items === '-' ? readStdin() : fs.readFileSync(flags.items, 'utf8');
    raw.split(/\r?\n/).forEach((line, i) => {
      if (!line.trim()) return;
      try {
        const o = JSON.parse(line);
        if (o && typeof o === 'object' && !Array.isArray(o)) {
          const { id, text, content, ...rest } = o;
          const body = text ?? content ?? JSON.stringify(rest);
          return push(String(id ?? i + 1), typeof body === 'string' ? body : JSON.stringify(body));
        }
      } catch {}
      push(String(i + 1), line);
    });
  }

  const files = [];
  for (const spec of pos) {
    if (spec === '-') { const t = readStdin(); flags.lines ? pushLines('stdin', t) : push('stdin', t); continue; }
    files.push(...expand(spec));
  }
  const seen = new Set();
  for (const f of files) {
    const abs = path.resolve(f);
    if (seen.has(abs)) continue;
    seen.add(abs);
    const r = rel(abs);
    if (exts && !exts.includes(path.extname(f).toLowerCase())) continue;
    if (!flags['no-secrets-guard'] && SECRET_RE.test(r)) { skipped.push(`${r} (secret-like, never sent)`); continue; }
    if (LOCK_RE.test(r)) continue;
    const text = readText(abs, 2 * 1024 * 1024);
    if (text === null) { skipped.push(`${r} (binary or >2MB)`); continue; }
    if (!text.trim()) continue;
    flags.lines ? pushLines(r, text) : push(r, text);
  }
  const limit = num(flags.limit, 5000);
  if (items.length > limit) die(`${items.length} items exceeds --limit ${limit}. Narrow the input or raise --limit.`);
  return { items, skipped };
}

// One item per request by default: packing items into a shared state measurably hurts accuracy
// (bench: CI triage 76% packed vs 100% unpacked). --fast packs small items for throughput.
function batches(items, flags) {
  const budget = num(flags['pack-tokens'], 3000), maxN = num(flags['pack-items'], flags.fast ? 40 : 1);
  const out = [];
  let cur = [], tok = 0;
  for (const it of items) {
    const t = estTokens(it.text) + 20;
    if (cur.length && (tok + t > budget || cur.length >= maxN)) { out.push(cur); cur = []; tok = 0; }
    cur.push(it); tok += t;
  }
  if (cur.length) out.push(cur);
  return out;
}

// Run one question per item. makeQ(ref, packed) builds the question; ref is how the item is addressed in state.
async function runPerItem(items, flags, makeQ) {
  const model = modelName(flags);
  const groups = batches(items, flags);
  const stats = { requests: groups.length, jevTokens: 0 };
  const results = await pool(groups.map((g) => async () => {
    const packed = g.length > 1;
    const state = packed
      ? { items: Object.fromEntries(g.map((it, j) => [`i${j}`, { source: it.id, content: it.text }])) }
      : { source: g[0].id, content: g[0].text };
    const questions = Object.fromEntries(g.map((_, j) => [`q${j}`, makeQ(packed ? `\`items.i${j}\`` : '`content`', packed)]));
    const res = await http('POST', DECIDE, { model, state, questions });
    stats.jevTokens += res.usage?.input_tokens || 0;
    stats.model = res.model;
    return g.map((it, j) => ({ item: it, answer: res.answers[`q${j}`] }));
  }), num(flags.concurrency, 16));
  return { rows: results.flat(), stats };
}

// ---------- output ----------

function footer(t0, items, extra, stats, outText, skipped) {
  const contentTok = items.reduce((a, it) => a + estTokens(it.text), 0);
  const saved = contentTok - estTokens(outText);
  const parts = [`${items.length} scanned`, ...extra, `${((Date.now() - t0) / 1000).toFixed(1)}s`,
    `jev ${fmtK(stats.jevTokens)} tok ($${(stats.jevTokens * PRICE_PER_TOKEN).toFixed(4)})`,
    `~${fmtK(Math.max(0, saved))} Claude tokens not read`];
  let s = `— ${parts.join(' · ')}`;
  if (skipped.length) s += `\n— skipped ${skipped.length}: ${clip(skipped.join(', '), 400)}`;
  recordStats({ requests: stats.requests, items: items.length, jevTokens: stats.jevTokens, saved });
  return s;
}

const fmtK = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));

function emit(flags, jsonObj, lines, foot) {
  if (flags.json) { process.stdout.write(JSON.stringify(jsonObj, null, 2) + '\n'); process.stderr.write(foot + '\n'); return; }
  const body = lines.join('\n');
  process.stdout.write((body ? body + '\n' : '') + foot + '\n');
}

function label(it, flags) {
  const t = it.truncated ? '~' : '';
  return flags.lines || flags.items ? `${it.id}${t}  ${clip(it.text.trim().replace(/\s+/g, ' '), num(flags.width, 160))}` : `${it.id}${t}`;
}

function requireInputs(items, cmd) {
  if (!items.length) die(`nothing to ${cmd}: pass files, directories, globs, --items FILE, or - for stdin`);
}

// ---------- commands ----------

// Log lines repeat with different numbers/ids; collapse them so Claude reads each pattern once.
const template = (t) => t.replace(/0x[0-9a-f]+/gi, '#').replace(/[0-9a-f]{8,}/gi, '#').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

// [3,4,5,9] -> "3-5,9"; stops after `max` numbers and points at --save for the rest.
function ranges(nums, max) {
  const parts = [];
  let shown = 0;
  for (let i = 0; i < nums.length && shown < max; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    parts.push(j > i ? `${nums[i]}-${nums[j]}` : `${nums[i]}`);
    shown += j - i + 1;
    i = j;
  }
  return parts.join(',') + (shown < nums.length ? `,… (+${nums.length - shown}; use --save for all)` : '');
}

function renderRows(rs, flags, score) {
  if (!flags.lines || flags['no-collapse']) return rs.map((r) => `${f2(score(r))}  ${label(r.item, flags)}`);
  const groups = new Map();
  for (const r of rs) {
    const k = template(r.item.text);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups.values()].map((g) => {
    if (g.length === 1) return `${f2(score(g[0]))}  ${label(g[0].item, flags)}`;
    const rest = g.slice(1).map((r) => Number(r.item.id.split(':').pop())).sort((a, b) => a - b);
    return `${f2(score(g[0]))}  ×${g.length}  ${label(g[0].item, flags)}\n        also lines ${ranges(rest, 300)}`;
  });
}

function save(flags, data) {
  if (!flags.save) return '';
  fs.writeFileSync(flags.save, JSON.stringify(data, null, 2));
  return `\n— full results saved to ${flags.save}`;
}

async function cmdFilter({ pos, flags }) {
  const question = pos.shift();
  if (!question) die('usage: filter "<yes/no question>" <paths...>');
  const t0 = Date.now();
  const { items, skipped } = collect(pos, flags);
  requireInputs(items, 'filter');
  const thr = num(flags.threshold, 0.5), band = num(flags.band, 0.15);
  const { rows, stats } = await runPerItem(items, flags, (ref, packed) => ({
    type: 'noul',
    instructions: packed ? { question, answer_about: `Answer only about ${ref}; ignore the other items.` } : question,
  }));
  rows.sort((a, b) => b.answer.noul - a.answer.noul);
  const p = (r) => r.answer.noul;
  const hits = rows.filter((r) => p(r) >= thr);
  const sure = rows.filter((r) => p(r) >= thr + band);
  const unsure = rows.filter((r) => Math.abs(p(r) - thr) < band);
  const lines = [
    ...renderRows(sure, flags, p),
    ...(unsure.length ? [`? borderline (${f2(thr - band)}–${f2(thr + band)}) — check these yourself:`, ...renderRows(unsure, flags, p)] : []),
  ];
  if (!sure.length && !unsure.length) lines.push('(no matches)');
  const saved = save(flags, rows.map((r) => ({ id: r.item.id, p: p(r) })));
  const foot = footer(t0, items, [`${hits.length} matched`, `${unsure.length} borderline`], stats, lines.join('\n'), skipped) + saved;
  emit(flags, { matched: hits.map((r) => ({ id: r.item.id, p: p(r) })), borderline: unsure.map((r) => ({ id: r.item.id, p: p(r) })) }, lines, foot);
}

function parseLabels(flags) {
  if (flags['labels-json']) {
    const raw = String(flags['labels-json']);
    return JSON.parse(raw.startsWith('@') ? fs.readFileSync(raw.slice(1), 'utf8') : raw);
  }
  if (!flags.labels) die('classify needs --labels "a,b,c" or --labels-json \'{"a":"description"}\'');
  return Object.fromEntries(String(flags.labels).split(',').map((s) => s.trim()).filter(Boolean).map((l) => {
    const [k, ...d] = l.split(':');
    return [k.trim(), d.length ? d.join(':').trim() : null];
  }));
}

async function cmdClassify({ pos, flags }) {
  const criteria = parseLabels(flags);
  const n = Object.keys(criteria).length;
  if (n < 2 || n > 255) die('classify needs 2–255 labels');
  const question = flags.question || 'Which label best describes this item?';
  const t0 = Date.now();
  const { items, skipped } = collect(pos, flags);
  requireInputs(items, 'classify');
  const minConf = num(flags['min-confidence'], 0.6);
  const { rows, stats } = await runPerItem(items, flags, (ref, packed) => ({
    type: 'choice',
    instructions: packed ? { question, answer_about: `Answer only about ${ref}; ignore the other items.` } : question,
    criteria,
  }));
  const groups = {};
  for (const r of rows) (groups[r.answer.choice] ||= []).push(r);
  const only = flags.only ? new Set(String(flags.only).split(',')) : null;
  const low = rows.filter((r) => r.answer.confidence < minConf);
  const lines = [Object.keys(criteria).map((k) => `${k} ${groups[k]?.length || 0}`).join(' · ')];
  for (const k of Object.keys(criteria)) {
    if (!groups[k] || (only && !only.has(k))) continue;
    const g = groups[k].sort((a, b) => b.answer.confidence - a.answer.confidence);
    if (flags.verbose) {
      lines.push(`[${k}]`);
      for (const r of g) lines.push(`${r.answer.confidence < minConf ? '?' : ' '}${f2(r.answer.confidence)}  ${label(r.item, flags)}`);
    } else {
      const ok = g.filter((r) => r.answer.confidence >= minConf).map((r) => r.item.id);
      if (ok.length) lines.push(`[${k}] ${ok.join(' ')}`);
    }
  }
  if (!flags.verbose && low.length) {
    lines.push('? low confidence — check these yourself:');
    for (const r of low.filter((r) => !only || only.has(r.answer.choice))) {
      const [second] = Object.entries(r.answer.probabilities).sort((a, b) => b[1] - a[1]).slice(1);
      lines.push(`?${f2(r.answer.confidence)}  ${r.answer.choice} (or ${second?.[0]})  ${r.item.id}  ${clip(r.item.text.trim().replace(/\s+/g, ' '), num(flags.width, 160))}`);
    }
  }
  const saved = save(flags, rows.map((r) => ({ id: r.item.id, label: r.answer.choice, confidence: r.answer.confidence })));
  const foot = footer(t0, items, [`${low.length} low-confidence (?)`], stats, lines.join('\n'), skipped) + saved;
  emit(flags, rows.map((r) => ({ id: r.item.id, label: r.answer.choice, confidence: r.answer.confidence, probabilities: r.answer.probabilities })), lines, foot);
}

const RANK_LEVELS = [
  'Unrelated to the query',
  'Shares a topic with the query but does not help answer it',
  'Partially relevant: contains some useful information for the query',
  'Relevant: substantially addresses the query',
  'Directly and specifically answers or matches the query',
];

async function cmdRank({ pos, flags }) {
  const query = pos.shift();
  if (!query) die('usage: rank "<query>" <paths...> [--top 10]');
  const t0 = Date.now();
  const { items, skipped } = collect(pos, flags);
  requireInputs(items, 'rank');
  const { rows, stats } = await runPerItem(items, flags, (ref, packed) => ({
    type: 'score',
    instructions: { query, question: `How relevant is ${ref} to \`query\`?${packed ? ' Ignore the other items.' : ''}` },
    criteria: RANK_LEVELS,
  }));
  const top = num(flags.top, 10), max = RANK_LEVELS.length - 1;
  rows.sort((a, b) => b.answer.score - a.answer.score);
  const shown = flags.all ? rows : rows.slice(0, top);
  const lines = shown.map((r) => `${f2(r.answer.score / max)}  ${label(r.item, flags)}`);
  const foot = footer(t0, items, [`top ${shown.length}`], stats, lines.join('\n'), skipped);
  emit(flags, shown.map((r) => ({ id: r.item.id, relevance: r.answer.score / max, confidence: r.answer.confidence })), lines, foot);
}

async function cmdFind({ pos, flags }) {
  const query = pos.shift();
  if (!query || !pos.length) die('usage: find "<what you are looking for>" <files...> [--top 5]');
  const t0 = Date.now();
  const model = modelName(flags);
  const chunkLines = Math.min(num(flags.chunk, 150), 250);
  const { items: files, skipped } = collect(pos, { ...flags, lines: false, 'max-chars': Infinity });
  requireInputs(files, 'find');
  const chunks = [];
  for (const f of files) {
    const all = f.text.split(/\r?\n/).map((t, i) => [String(i + 1), t]).filter(([, t]) => t.trim());
    for (let i = 0; i < all.length; i += chunkLines) chunks.push({ file: f.id, lines: all.slice(i, i + chunkLines) });
  }
  const stats = { requests: chunks.length, jevTokens: 0 };
  const perChunk = await pool(chunks.map((c) => async () => {
    const lines = Object.fromEntries(c.lines.map(([n, t]) => [n, clip(t, 400)]));
    const res = await http('POST', DECIDE, {
      model,
      state: { query, lines },
      questions: {
        where: {
          type: 'choice',
          instructions: 'Which line number in `lines` best matches `query`?',
          criteria: { ...Object.fromEntries(c.lines.map(([n]) => [n, null])), none: 'No line matches `query`' },
        },
        exists: { type: 'noul', instructions: 'Does any line in `lines` match `query`?' },
      },
    });
    stats.jevTokens += res.usage?.input_tokens || 0;
    const ex = res.answers.exists.noul;
    return Object.entries(res.answers.where.probabilities)
      .filter(([n]) => n !== 'none')
      .map(([n, p]) => ({ file: c.file, line: n, text: lines[n], score: p * ex }));
  }), num(flags.concurrency, 16));
  const top = num(flags.top, 5), minScore = num(flags['min-score'], 0.05);
  const hits = perChunk.flat().filter((h) => h.score >= minScore).sort((a, b) => b.score - a.score).slice(0, top);
  const out = hits.map((h) => `${f2(h.score)}  ${h.file}:${h.line}  ${clip(h.text.trim(), num(flags.width, 160))}`);
  if (!out.length) out.push('(no matching lines)');
  const foot = footer(t0, files, [`${chunks.length} chunks`], stats, out.join('\n'), skipped);
  emit(flags, hits, out, foot);
}

function fmtAnswer(id, a) {
  if (a.type === 'noul') return `${id}  noul ${f2(a.noul)}`;
  if (a.type === 'choice') return `${id}  choice ${a.choice} (conf ${f2(a.confidence)})`;
  if (a.type === 'score') {
    const lvl = a.legend?.[String(Math.round(a.score))];
    return `${id}  score ${f2(a.score)}/${Object.keys(a.legend || {}).length - 1}${lvl ? ` "${clip(lvl, 60)}"` : ''} (conf ${f2(a.confidence)})`;
  }
  return `${id}  ${JSON.stringify(a)}`;
}

function readStateArg(v) {
  if (v === undefined) return undefined;
  if (v === '-') return readStdin();
  if (typeof v === 'string' && v.startsWith('@')) return fs.readFileSync(v.slice(1), 'utf8');
  return v;
}

async function cmdAsk({ pos, flags }) {
  const t0 = Date.now();
  let body;
  const first = pos[0];
  if (first && (first === '-' || first.endsWith('.json')) && !flags.state) {
    body = JSON.parse(first === '-' ? readStdin() : fs.readFileSync(first, 'utf8'));
  } else {
    const question = pos.join(' ');
    if (!question) die('usage: ask "<question>" --state @file|text|- [--choice "a,b" | --score "low|mid|high"]  or  ask spec.json');
    const state = readStateArg(flags.state);
    if (state === undefined) die('ask needs --state (@file, literal text, or - for stdin)');
    let q = { type: 'noul', instructions: question };
    if (flags.choice) q = { type: 'choice', instructions: question, criteria: parseLabels({ labels: flags.choice }) };
    if (flags.score) q = { type: 'score', instructions: question, criteria: String(flags.score).split('|').map((s) => s.trim()) };
    body = { state, questions: { answer: q } };
  }
  body.model ||= modelName(flags);
  if (!body.state || !body.questions) die('spec needs "state" and "questions"');
  const res = await http('POST', DECIDE, body);
  const lines = Object.entries(res.answers).map(([id, a]) => fmtAnswer(id, a));
  const stateText = typeof body.state === 'string' ? body.state : JSON.stringify(body.state);
  const foot = footer(t0, [{ text: stateText }], [], { requests: 1, jevTokens: res.usage?.input_tokens || 0 }, lines.join('\n'), []);
  emit(flags, res, lines, foot.replace('1 scanned · ', ''));
}

async function promptHidden(q) {
  if (!process.stdin.isTTY) return readStdin().trim();
  process.stderr.write(q);
  return new Promise((resolve) => {
    let s = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', function onData(ch) {
      for (const c of ch) {
        if (c === '\r' || c === '\n' || c === '\u0004') {
          process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData);
          process.stderr.write('\n'); return resolve(s.trim());
        }
        if (c === '\u0003') { process.stderr.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') { if (s.length) { s = s.slice(0, -1); process.stderr.write('\b \b'); } continue; }
        s += c; process.stderr.write('*');
      }
    });
  });
}

async function cmdSetup({ pos, flags }) {
  if (OPENROUTER) die('the openrouter route reads OPENROUTER_API_KEY from the environment and needs no setup; nothing was saved', 3);
  if (flags.remove) {
    const cfg = readJson(CONFIG, {});
    delete cfg.api_key;
    writeJson(CONFIG, cfg, 0o600);
    return console.log(`Removed saved key from ${CONFIG}`);
  }
  const key = (pos[0] || (await promptHidden(`Paste your Jev API key (from ${KEY_URL}): `))).trim();
  if (!key) die(`no key given. Get one at ${KEY_URL}`);
  const res = await fetch(`${API}/v1/models`, { headers: { Authorization: `Bearer ${key}` } }).catch((e) => die(`network error: ${e.message}`));
  if (res.status === 401 || res.status === 403) die(`that key was rejected by Jev (${res.status}). Double-check it at ${KEY_URL}`, 3);
  if (!res.ok) die(`could not verify key: HTTP ${res.status}`);
  const cfg = readJson(CONFIG, {});
  cfg.api_key = key;
  if (flags.model) cfg.model = flags.model;
  writeJson(CONFIG, cfg, 0o600);
  console.log(`✓ Jev key verified and saved to ${CONFIG}. Quicksilver is ready.`);
}

async function cmdStatus() {
  const env = OPENROUTER ? 'OPENROUTER_API_KEY' : process.env.JEV_API_KEY ? 'JEV_API_KEY' : process.env.TYPESAFE_API_KEY ? 'TYPESAFE_API_KEY' : null;
  const key = apiKey();
  if (!key && OPENROUTER) { console.log('not configured — OPENROUTER_API_KEY is not set in the environment'); process.exit(3); }
  if (!key) { console.log(`not configured — get a key at ${KEY_URL}, then run: node qs.mjs setup`); process.exit(3); }
  // OpenRouter's /models answers 200 without a key, so verify against its authenticated /key endpoint instead.
  const res = await fetch(`${API}${OPENROUTER ? '/v1/key' : '/v1/models'}`, { headers: { Authorization: `Bearer ${key}` } }).catch(() => null);
  const s = readJson(STATS, null);
  const src = env ? `env ${env}` : CONFIG;
  if (!res) console.log(`key found (${src}) but ${OPENROUTER ? 'OpenRouter' : 'Jev'} is unreachable right now`);
  else if (!res.ok && OPENROUTER) { console.log(`key found (${src}) but rejected by OpenRouter (HTTP ${res.status})`); process.exit(3); }
  else if (!res.ok) { console.log(`key found (${src}) but rejected (HTTP ${res.status}) — run setup with a fresh key from ${KEY_URL}`); process.exit(3); }
  else console.log(`ready · key from ${src} · model ${modelName({})}`);
  if (s) console.log(`since ${s.since.slice(0, 10)}: ${s.runs} runs · ${fmtK(s.items)} items judged · jev ${fmtK(s.jev_input_tokens)} tok ($${(s.jev_input_tokens * PRICE_PER_TOKEN).toFixed(4)}) · ~${fmtK(s.claude_tokens_saved)} Claude tokens not read`);
}

const HELP = `quicksilver — delegate bulk judgment calls to Jev

  setup [KEY]                          save + verify your Jev key (prompts if omitted)
  status                               check key, show lifetime savings
  filter "<yes/no question>" <inputs>  keep only items where the answer is yes
  classify --labels "a,b,c" <inputs>   put each item in one bucket
  rank "<query>" <inputs> [--top N]    order items by relevance
  find "<what>" <files> [--top N]      locate the lines in large files that match
  ask "<question>" --state @file       one-off yes/no (or --choice / --score)
  ask spec.json                        raw {state, questions} request

inputs: files, directories (respects .gitignore), globs, - (stdin), --items FILE.jsonl
common: --lines (each line is an item) --ext ts,tsx --json --threshold 0.5 --save FILE
        --verbose (classify: one line per item) --no-collapse (lines: don't merge repeats)
        --concurrency 16 --max-chars 60000 --limit 5000 --model jev-latest
        --route openrouter (opt in to Jev via OpenRouter; or QS_ROUTE=openrouter; key in OPENROUTER_API_KEY)
        --fast (pack small items per request: faster, less accurate)`;

const COMMANDS = { setup: cmdSetup, status: cmdStatus, filter: cmdFilter, classify: cmdClassify, rank: cmdRank, find: cmdFind, ask: cmdAsk };

process.on('unhandledRejection', (e) => die(`unexpected error: ${e?.stack || e}`, 5));
process.on('uncaughtException', (e) => die(`unexpected error: ${e?.stack || e}`, 5));

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { console.log(HELP); process.exit(0); }
if (!COMMANDS[cmd]) die(`unknown command "${cmd}"\n\n${HELP}`);
await COMMANDS[cmd](parseArgs(rest));
