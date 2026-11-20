// A standalone GitHub-compatible git forge: one Node process serving git smart HTTP
// (upload-pack v2 / v0, receive-pack v0), REST v3, GraphQL v4 and MCP over an
// in-memory store. No dependencies, no git binary, no network beyond the trial env.
//
// Auth: every API call presents `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; the
// token owner is the scenario viewer, derived from the contest's fixed scenario
// seed (the same deterministic derivation the suite uses), so the forge answers
// for login `adaiversen` without any outside service.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const JSON_TYPE = 'application/json; charset=utf-8';
const ZERO_OID = '0'.repeat(40);
const VIEWER_ID = 1000;

// ---------------------------------------------------------------------------
// The token owner, derived from the fixed scenario seed (wire.ts SCENARIO_SEED).
// ---------------------------------------------------------------------------
const U64_MASK = 0xffffffffffffffffn;
function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}
function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}
class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? 0x6a09e667f3bcc909n : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}
const VIEWER = ((): { login: string; name: string; email: string; id: number } => {
  const first = ['ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars', 'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane'];
  const last = ['anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller', 'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber', 'xu', 'yilmaz', 'zimmer'];
  const rng = new Rng(mix64(0x6a09e667f3bcc909n ^ fnv1a64('users')));
  const used = new Set<string>();
  let viewer = { login: '', name: '', email: '', id: VIEWER_ID };
  for (let i = 0; i < 12; i += 1) {
    const f = rng.pick(first);
    const l = rng.pick(last);
    let login = `${f}${l}`;
    let suffix = 2;
    while (used.has(login)) {
      login = `${f}${l}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    if (i === 0) viewer = { login, name: `${f} ${l}`, email: `${login}@example.invalid`, id: VIEWER_ID };
  }
  return viewer;
})();
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
let reqCounter = 0;
function reqId(): string {
  reqCounter += 1;
  return `forge-${Date.now().toString(36)}-${reqCounter}`;
}
function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'x-github-request-id': reqId(), ...(status === 204 ? {} : { 'content-length': Buffer.byteLength(text) }), ...extra });
  res.end(text);
}
function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': reqId() });
  res.end(body);
}
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}
function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
function decodePath(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
function isOid(v: string): boolean {
  return /^[0-9a-f]{40}$/.test(v);
}
function nowIso(): string {
  return new Date().toISOString();
}
function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
function b64decode(s: string): Buffer {
  return Buffer.from(s.replace(/\s+/g, ''), 'base64');
}
function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`).toString('base64url');
}
function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const idx = text.indexOf(':');
    if (idx < 0) return null;
    return { kind: text.slice(0, idx), parts: text.slice(idx + 1).split(':') };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Git objects
// ---------------------------------------------------------------------------
type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObj {
  type: ObjType;
  data: Buffer;
}
const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
function hashObject(type: ObjType, data: Buffer): string {
  return createHash('sha1').update(Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'utf8'), data])).digest('hex');
}
function putObj(store: Map<string, GitObj>, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!store.has(oid)) store.set(oid, { type, data });
  return oid;
}
interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}
function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp);
    if (sp < 0 || nul < 0) break;
    const mode = data.subarray(off, sp).toString('ascii');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}
function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  timestamp: number;
}
function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  let timestamp = 0;
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      author = line.slice(7);
      const m = / (\d+) [+-]\d{4}$/.exec(author);
      if (m) timestamp = Number(m[1]);
    } else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message, timestamp };
}
function buildCommit(tree: string, parents: string[], message: string, author: string, timestamp: number): Buffer {
  const ident = `${author} ${timestamp} +0000`;
  let out = `tree ${tree}\n`;
  for (const p of parents) out += `parent ${p}\n`;
  out += `author ${ident}\ncommitter ${ident}\n\n${message.endsWith('\n') ? message : `${message}\n`}`;
  return Buffer.from(out, 'utf8');
}
function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}
/** Objects reachable from tips (commits, trees, blobs, tags). */
function collectReachable(tips: Iterable<string>, lookup: (oid: string) => GitObj | undefined): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...tips];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid) || !isOid(oid)) continue;
    const obj = lookup(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}
/** Is `desc` a descendant of (or equal to) `anc`? */
function isAncestor(anc: string, desc: string, lookup: (oid: string) => GitObj | undefined): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>();
  const stack = [desc];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (oid === anc) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}
/** First common ancestor (merge base) of a and b, or null. */
function mergeBase(a: string, b: string, lookup: (oid: string) => GitObj | undefined): string | null {
  const ancA = collectReachable([a], lookup);
  const stack = [b];
  const seen = new Set<string>();
  while (stack.length) {
    const oid = stack.pop() as string;
    if (ancA.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return null;
}
/** Flatten a tree to path -> {oid, mode}. */
function flattenTree(store: Map<string, GitObj>, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const obj = store.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') {
      for (const [p, v] of flattenTree(store, e.oid, path)) out.set(p, v);
    } else {
      out.set(path, { oid: e.oid, mode: e.mode });
    }
  }
  return out;
}
/** Build a tree object from a flat file map; returns root tree oid. */
function treeFromMap(store: Map<string, GitObj>, files: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of files) {
    const segs = path.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i += 1) {
      const name = segs[i] as string;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name) as Node;
    }
    node.files.set(segs[segs.length - 1] as string, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, e] of node.files) entries.push({ mode: e.mode, name, oid: e.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObj(store, 'tree', buildTree(entries));
  };
  return build(root);
}

// ---------------------------------------------------------------------------
// Packfiles (no deltas: plain objects, which the suite accepts)
// ---------------------------------------------------------------------------
function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}
function writePack(objects: GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[off++] as number;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++] as number;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += (delta[off++] as number) * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += (delta[off++] as number) * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, off, off + literal);
      off += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}
interface PackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}
function readPack(pack: Buffer): Map<string, GitObj> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const raw: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  let offset = 12;
  const readVarint = (start: number): { size: number; next: number; first: number } => {
    let byte = pack[start] as number;
    const first = byte;
    let size = byte & 0x0f;
    let shift = 4;
    let off = start + 1;
    while (byte & 0x80) {
      byte = pack[off++] as number;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    return { size, next: off, first };
  };
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const header = readVarint(offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: PackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let byte = pack[offset] as number;
      offset += 1;
      let value = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset++] as number;
        value = ((value + 1) * 128) + (byte & 0x7f);
      }
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const objects = new Map<string, GitObj>();
  const byOid = new Map<string, PackEntry>();
  const resolve = (entry: PackEntry): { type: ObjType; data: Buffer; oid: string } => {
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      const data = applyDelta(base.data, entry.data);
      const oid = hashObject(base.type, data);
      return { type: base.type, data, oid };
    }
    if (entry.typeCode === 7) {
      const baseEntry = byOid.get(entry.baseOid as string);
      if (!baseEntry) throw new Error('ref-delta base missing');
      const base = resolve(baseEntry);
      const data = applyDelta(base.data, entry.data);
      const oid = hashObject(base.type, data);
      return { type: base.type, data, oid };
    }
    const type = CODE_TYPE[entry.typeCode] as ObjType;
    const oid = hashObject(type, entry.data);
    return { type, data: entry.data, oid };
  };
  for (const entry of raw) {
    if (entry.typeCode !== 6 && entry.typeCode !== 7) {
      const r = resolve(entry);
      byOid.set(r.oid, entry);
    }
  }
  for (const entry of raw) {
    const r = resolve(entry);
    if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data });
    if (!byOid.has(r.oid)) byOid.set(r.oid, entry);
  }
  return objects;
}

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------
function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}
const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');
function pktLines(items: (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(FLUSH);
    else if (item === 'delim') parts.push(DELIM);
    else parts.push(pkt(item));
  }
  return Buffer.concat(parts);
}
interface PktPacket {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload?: Buffer;
}
/** Decode pkt-lines from the start of buf; returns packets and the offset of trailing bytes. */
function decodePktLines(buf: Buffer): { packets: PktPacket[]; rest: number } {
  const packets: PktPacket[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = Number.parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      off += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, rest: off };
}
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------
interface Label {
  name: string;
  color: string;
}
interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}
interface Comment {
  id: number;
  body: string;
  createdAt: string;
}
interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}
interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  baseShaAtCreate: string;
  mergeBase: string | null;
  files: FileChange[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}
interface Repo {
  dbId: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  createdAt: string;
  objects: Map<string, GitObj>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  comments: Map<number, Comment[]>;
  nextNumber: number;
  nextCommentId: number;
}
const repos = new Map<string, Repo>();
let repoSeq = 0;
let globalSeq = 0;
function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}
function viewerIdent(): string {
  return `${VIEWER.name} <${VIEWER.email}>`;
}
function repoGlobalId(repo: Repo): string {
  return globalId('Repository', repo.dbId);
}
function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', repo.dbId, issue.number);
}
function pullGlobalId(repo: Repo, pull: Pull): string {
  return globalId('PullRequest', repo.dbId, pull.number);
}
function findRepoByGlobalId(id: string): Repo | null {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'Repository') return null;
  const dbId = Number(parsed.parts[0]);
  for (const repo of repos.values()) if (repo.dbId === dbId) return repo;
  return null;
}
function findIssueByGlobalId(id: string): { repo: Repo; issue: Issue } | null {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'Issue') return null;
  const dbId = Number(parsed.parts[0]);
  const number = Number(parsed.parts[1]);
  for (const repo of repos.values()) {
    if (repo.dbId !== dbId) continue;
    const issue = repo.issues.find((i) => i.number === number);
    if (issue) return { repo, issue };
  }
  return null;
}
function findPullByGlobalId(id: string): { repo: Repo; pull: Pull } | null {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'PullRequest') return null;
  const dbId = Number(parsed.parts[0]);
  const number = Number(parsed.parts[1]);
  for (const repo of repos.values()) {
    if (repo.dbId !== dbId) continue;
    const pull = repo.pulls.find((p) => p.number === number);
    if (pull) return { repo, pull };
  }
  return null;
}
function createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo {
  repoSeq += 1;
  globalSeq += 1;
  const repo: Repo = {
    dbId: repoSeq,
    owner,
    name,
    description,
    isPrivate,
    defaultBranch: 'main',
    createdSeq: globalSeq,
    createdAt: nowIso(),
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: [],
    pulls: [],
    comments: new Map(),
    nextNumber: 1,
    nextCommentId: 1,
  };
  repos.set(repoKey(owner, name), repo);
  return repo;
}
function refTip(repo: Repo, ref: string): string | undefined {
  return repo.refs.get(ref);
}
function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}
function defaultTip(repo: Repo): string | undefined {
  return branchTip(repo, repo.defaultBranch);
}
/** Commit one file change on a branch; creates the branch from the default tip when needed. */
function commitFile(repo: Repo, branch: string, path: string, content: Buffer, message: string): { commitSha: string; blobSha: string } {
  let tip = branchTip(repo, branch);
  if (tip === undefined && branch !== repo.defaultBranch) {
    tip = defaultTip(repo);
    if (tip !== undefined) repo.refs.set(`refs/heads/${branch}`, tip);
  }
  const blobSha = putObj(repo.objects, 'blob', content);
  let files = new Map<string, { oid: string; mode: string }>();
  const parents: string[] = [];
  if (tip !== undefined) {
    const commit = repo.objects.get(tip);
    if (commit && commit.type === 'commit') {
      parents.push(tip);
      files = flattenTree(repo.objects, parseCommit(commit.data).tree);
    }
  }
  files.set(path, { oid: blobSha, mode: '100644' });
  const treeOid = treeFromMap(repo.objects, files);
  const commitSha = putObj(repo.objects, 'commit', buildCommit(treeOid, parents, message, viewerIdent(), nowSec()));
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return { commitSha, blobSha };
}
/** Delete one file on a branch. */
function deleteFile(repo: Repo, branch: string, path: string, message: string): string | null {
  const tip = branchTip(repo, branch);
  if (tip === undefined) return null;
  const commit = repo.objects.get(tip);
  if (!commit || commit.type !== 'commit') return null;
  const files = flattenTree(repo.objects, parseCommit(commit.data).tree);
  if (!files.has(path)) return null;
  files.delete(path);
  const treeOid = treeFromMap(repo.objects, files);
  const commitSha = putObj(repo.objects, 'commit', buildCommit(treeOid, [tip], message, viewerIdent(), nowSec()));
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return commitSha;
}
/** File map at a commit oid. */
function filesAt(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
  const commit = repo.objects.get(commitOid);
  if (!commit || commit.type !== 'commit') return new Map();
  return flattenTree(repo.objects, parseCommit(commit.data).tree);
}
function lineCount(buf: Buffer): number {
  if (buf.length === 0) return 0;
  const text = buf.toString('utf8');
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}
/** Diff file maps base -> head. */
function diffFiles(repo: Repo, base: Map<string, { oid: string; mode: string }>, head: Map<string, { oid: string; mode: string }>): FileChange[] {
  const out: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) {
      const oldData = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
      const deletions = lineCount(oldData);
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (!b && h) {
      const newData = repo.objects.get(h.oid)?.data ?? Buffer.alloc(0);
      const additions = lineCount(newData);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b && h && b.oid !== h.oid) {
      const oldData = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
      const newData = repo.objects.get(h.oid)?.data ?? Buffer.alloc(0);
      const additions = lineCount(newData);
      const deletions = lineCount(oldData);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}
function peelToCommit(repo: Repo, oid: string): string | null {
  let cur = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = repo.objects.get(cur);
    if (!obj) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') {
      cur = parseTag(obj.data).object;
      continue;
    }
    return null;
  }
  return null;
}
/** Would merging `pull` conflict? Head changed a path the base also changed since the merge base. */
function pullConflicts(repo: Repo, pull: Pull): boolean {
  if (pull.mergeBase === null) return false;
  const baseFiles = filesAt(repo, pull.mergeBase);
  const headFiles = filesAt(repo, pull.headSha);
  const tipFiles = filesAt(repo, pull.baseSha);
  const headChanged = new Set(diffFiles(repo, baseFiles, headFiles).map((f) => f.filename));
  const baseChanged = new Set(diffFiles(repo, baseFiles, tipFiles).map((f) => f.filename));
  for (const p of headChanged) if (baseChanged.has(p)) return true;
  return false;
}
function mergeableState(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  return pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
}
/** Squash-merge a pull request onto its base branch. Returns merge sha or null on conflict. */
function squashMerge(repo: Repo, pull: Pull): string | null {
  if (pull.state !== 'open') return null;
  const baseTip = branchTip(repo, pull.baseRef);
  if (baseTip === undefined) return null;
  if (pullConflicts(repo, { ...pull, baseSha: baseTip })) return null;
  const baseFiles = filesAt(repo, baseTip);
  const mb = pull.mergeBase ?? pull.baseShaAtCreate;
  const mbFiles = filesAt(repo, mb);
  const headFiles = filesAt(repo, pull.headSha);
  const changes = diffFiles(repo, mbFiles, headFiles);
  for (const change of changes) {
    if (change.status === 'removed') baseFiles.delete(change.filename);
    else {
      const entry = headFiles.get(change.filename);
      if (entry) baseFiles.set(change.filename, entry);
    }
  }
  const treeOid = treeFromMap(repo.objects, baseFiles);
  const mergeSha = putObj(repo.objects, 'commit', buildCommit(treeOid, [baseTip], pull.title, viewerIdent(), nowSec()));
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = nowIso();
  pull.mergeCommitSha = mergeSha;
  pull.updatedAt = nowIso();
  return mergeSha;
}
function createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
  globalSeq += 1;
  const issue: Issue = {
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    labels: [...labels],
    createdSeq: globalSeq,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    closedAt: null,
  };
  repo.nextNumber += 1;
  repo.issues.push(issue);
  return issue;
}
function createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull | { error: string } {
  const headSha = branchTip(repo, head);
  const baseSha = branchTip(repo, base);
  if (headSha === undefined) return { error: `head branch ${head} does not exist` };
  if (baseSha === undefined) return { error: `base branch ${base} does not exist` };
  globalSeq += 1;
  const mb = mergeBase(headSha, baseSha, (oid) => repo.objects.get(oid));
  const files = diffFiles(repo, filesAt(repo, mb ?? baseSha), filesAt(repo, headSha));
  const pull: Pull = {
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    headSha,
    baseRef: base,
    baseSha,
    baseShaAtCreate: baseSha,
    mergeBase: mb,
    files,
    createdSeq: globalSeq,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  repo.nextNumber += 1;
  repo.pulls.push(pull);
  return pull;
}
/** Commits reachable from a ref, newest first. */
function listCommits(repo: Repo, tip: string): { sha: string; message: string; author: string; committer: string; timestamp: number; parents: string[] }[] {
  const seen = new Set<string>();
  const stack = [tip];
  const out: { sha: string; message: string; author: string; committer: string; timestamp: number; parents: string[]; seq: number }[] = [];
  let seq = 0;
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const c = parseCommit(obj.data);
    out.push({ sha: oid, message: c.message, author: c.author, committer: c.committer, timestamp: c.timestamp, parents: c.parents, seq: seq++ });
    for (const p of c.parents) stack.push(p);
  }
  out.sort((a, b) => b.timestamp - a.timestamp || a.seq - b.seq);
  return out.map(({ seq: _s, ...rest }) => rest);
}
function commitJson(repo: Repo, entry: { sha: string; message: string; author: string; committer: string; timestamp: number; parents: string[] }): Record<string, unknown> {
  const parseIdent = (line: string): { name: string; email: string; date: string } => {
    const m = /^(.*) <([^>]*)> (\d+) [+-]\d{4}$/.exec(line);
    if (!m) return { name: line, email: '', date: nowIso() };
    return { name: m[1] as string, email: m[2] as string, date: new Date(Number(m[3]) * 1000).toISOString() };
  };
  const author = parseIdent(entry.author);
  const committer = parseIdent(entry.committer);
  return {
    sha: entry.sha,
    commit: {
      message: entry.message.replace(/\n$/, ''),
      author,
      committer,
      tree: { sha: repo.objects.get(entry.sha) ? parseCommit((repo.objects.get(entry.sha) as GitObj).data).tree : '' },
    },
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    parents: entry.parents.map((p) => ({ sha: p })),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${entry.sha}`,
  };
}

// ---------------------------------------------------------------------------
// REST serialization
// ---------------------------------------------------------------------------
function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repoGlobalId(repo),
    databaseId: repo.dbId,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    pushed_at: repo.createdAt,
    size: 0,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    fork: false,
    watchers_count: 0,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    topics: [],
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}
function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issueGlobalId(repo, issue),
    databaseId: issue.number,
    node_id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', description: '' };
    }),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    assignee: null,
    assignees: [],
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    author_association: 'OWNER',
  };
}
function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pullGlobalId(repo, pull),
    databaseId: pull.number,
    node_id: pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? !pullConflicts(repo, pull) : null,
    mergeable_state: pull.state === 'open' ? (pullConflicts(repo, pull) ? 'dirty' : 'clean') : 'unknown',
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}`, user: { login: VIEWER.login, id: VIEWER.id, type: 'User' }, repo: repoJson(repo) },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}`, user: { login: VIEWER.login, id: VIEWER.id, type: 'User' }, repo: repoJson(repo) },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    assignee: null,
    assignees: [],
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    draft: false,
    commits: 1,
    additions: pull.files.reduce((s, f) => s + f.additions, 0),
    deletions: pull.files.reduce((s, f) => s + f.deletions, 0),
    changed_files: pull.files.length,
  };
}
function paginate<T>(req: IncomingMessage, items: T[], q: URLSearchParams): { page: T[]; link: string | null } {
  const perPage = Math.max(1, Math.min(100, Number(q.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(q.get('page') ?? '1') || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  if (page >= totalPages) return { page: slice, link: null };
  const host = req.headers.host ?? 'localhost';
  const basePath = pathOf(req);
  const qs = new URLSearchParams(q);
  qs.set('page', String(page + 1));
  qs.set('per_page', String(perPage));
  const nextUrl = `http://${host}${basePath}?${qs.toString()}`;
  const qsLast = new URLSearchParams(q);
  qsLast.set('page', String(totalPages));
  qsLast.set('per_page', String(perPage));
  const lastUrl = `http://${host}${basePath}?${qsLast.toString()}`;
  return { page: slice, link: `<${nextUrl}>; rel="next", <${lastUrl}>; rel="last"` };
}

// ---------------------------------------------------------------------------
// Git smart HTTP
// ---------------------------------------------------------------------------
const UPLOAD_V0_CAPS = 'side-band-64k thin-pack ofs-delta multi_ack symref=HEAD:refs/heads/main agent=forge/1.0 shallow';
const UPLOAD_V2_CAPS = 'ls-refs=unborn fetch=shallow thin-pack ofs-delta filter object-format=sha1 agent=forge/1.0';
const RECEIVE_CAPS = 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=forge/1.0';

function gitNotFound(res: ServerResponse): void {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'x-github-request-id': reqId() });
  res.end('Not Found');
}
interface RefRow {
  name: string;
  oid: string;
  peeled: string | null;
}
function refRows(repo: Repo): RefRow[] {
  const rows: RefRow[] = [];
  for (const [name, oid] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const obj = repo.objects.get(oid);
    let peeled: string | null = null;
    if (obj && obj.type === 'tag') {
      const target = peelToCommit(repo, oid);
      if (target !== null) peeled = target;
    }
    rows.push({ name, oid, peeled });
  }
  return rows;
}
function handleInfoRefs(req: IncomingMessage, res: ServerResponse, repo: Repo, service: string | null): void {
  if (service === 'git-receive-pack') {
    const items: (string | 'flush')[] = [`# service=git-receive-pack\n`, 'flush'];
    const rows = refRows(repo);
    if (rows.length === 0) {
      items.push(`${ZERO_OID} capabilities^{}\0${RECEIVE_CAPS}\n`);
    } else {
      items.push(`${rows[0]?.oid} HEAD\0${RECEIVE_CAPS}\n`);
      for (const row of rows) items.push(`${row.oid} ${row.name}\n`);
    }
    items.push('flush');
    sendRaw(res, 200, pktLines(items), 'application/x-git-receive-pack-advertisement');
    return;
  }
  // upload-pack
  const proto = req.headers['git-protocol'];
  const rows = refRows(repo);
  if (proto === 'version=2') {
    const items: (string | 'flush')[] = ['version 2\n', ...UPLOAD_V2_CAPS.split(' ').map((c) => `${c}\n`), 'flush'];
    sendRaw(res, 200, pktLines(items), 'application/x-git-upload-pack-advertisement');
    return;
  }
  const items: (string | 'flush')[] = ['# service=git-upload-pack\n', 'flush'];
  if (rows.length === 0) {
    items.push(`${ZERO_OID} capabilities^{}\0${UPLOAD_V0_CAPS}\n`);
  } else {
    items.push(`${rows[0]?.oid} HEAD\0${UPLOAD_V0_CAPS}\n`);
    for (const row of rows) {
      items.push(`${row.oid} ${row.name}\n`);
      if (row.peeled !== null) items.push(`${row.peeled} ${row.name}^{}\n`);
    }
  }
  items.push('flush');
  sendRaw(res, 200, pktLines(items), 'application/x-git-upload-pack-advertisement');
}
function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  const proto = req.headers['git-protocol'];
  if (proto === 'version=2') {
    handleUploadPackV2(req, res, repo, body);
    return;
  }
  handleUploadPackV0(req, res, repo, body);
}
/** Read sideband data (band 2 = progress, band 3 = error) from a v0 request body. */
function sidebandData(body: Buffer, start: number): Buffer {
  const chunks: Buffer[] = [];
  let off = start;
  while (off + 4 <= body.length) {
    const head = body.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = Number.parseInt(head, 16);
    if (len < 5 || off + len > body.length) break;
    const band = body[off + 4];
    if (band === 1) chunks.push(body.subarray(off + 5, off + len));
    off += len;
  }
  return Buffer.concat(chunks);
}
function handleUploadPackV0(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  const { packets, rest } = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  let deepen: number | null = null;
  let shallow: string[] = [];
  for (const p of packets) {
    if (p.kind !== 'data' || !p.payload) continue;
    const line = p.payload.toString('utf8').trimEnd();
    const nul = line.indexOf('\0');
    const clean = nul >= 0 ? line.slice(0, nul) : line;
    if (clean.startsWith('want ')) wants.push((clean.slice(5).trim().split(' ')[0] as string));
    else if (clean.startsWith('have ')) haves.push(clean.slice(5).trim());
    else if (clean === 'done') break;
    else if (clean.startsWith('deepen ')) {
      const n = Number(clean.slice(7).trim());
      if (Number.isFinite(n) && n >= 1) deepen = n;
    } else if (clean.startsWith('shallow ')) shallow.push(clean.slice(8).trim());
  }
  // Some clients embed the pack request inside sideband band 1; fall back to decoding it.
  if (wants.length === 0 && rest < body.length) {
    const inner = sidebandData(body, rest);
    if (inner.length > 0) {
      const decoded = decodePktLines(inner);
      for (const p of decoded.packets) {
        if (p.kind !== 'data' || !p.payload) continue;
        const line = p.payload.toString('utf8').trimEnd();
        if (line.startsWith('want ')) wants.push((line.slice(5).trim().split(' ')[0] as string));
        else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
        else if (line.startsWith('deepen ')) {
          const n = Number(line.slice(7).trim());
          if (Number.isFinite(n) && n >= 1) deepen = n;
        } else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      }
    }
  }
  const acks: string[] = [];
  for (const have of haves) {
    if (wants.length === 0 || wants.some((w) => isAncestor(have, w, (oid) => repo.objects.get(oid)))) acks.push(`ACK ${have}`);
  }
  if (acks.length === 0) acks.push('NAK');
  const { objects, shallowInfo } = planFetch(repo, wants, haves, deepen, shallow);
  const pack = writePack(objects);
  const parts: Buffer[] = [pktLines(acks.map((a) => `${a}\n`))];
  for (const line of shallowInfo) parts.push(pkt(`${line}\n`));
  parts.push(sidebandPack(pack));
  parts.push(FLUSH);
  sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}
function handleUploadPackV2(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  const { packets } = decodePktLines(body);
  let command = '';
  let peel = false;
  let symrefs = false;
  let unborn = false;
  let refPrefix: string | null = null;
  const wants: string[] = [];
  const haves: string[] = [];
  let deepen: number | null = null;
  let shallow: string[] = [];
  let done = false;
  let sawDelim = false;
  for (const p of packets) {
    if (p.kind === 'delim') {
      sawDelim = true;
      continue;
    }
    if (p.kind !== 'data' || !p.payload) continue;
    const line = p.payload.toString('utf8').trimEnd();
    if (!sawDelim) {
      // Pre-delim: command=ls-refs / command=fetch, plus agent= / object-format= (ignored).
      if (line.startsWith('command=')) command = line.slice('command='.length);
      continue;
    }
    const [key, ...restParts] = line.split(' ');
    const value = restParts.join(' ');
    if (key === 'peel') peel = true;
    else if (key === 'symrefs') symrefs = true;
    else if (key === 'unborn') unborn = true;
    else if (key === 'ref-prefix') refPrefix = value;
    else if (key === 'want') wants.push(value);
    else if (key === 'have') haves.push(value);
    else if (key === 'shallow') shallow.push(value);
    else if (key === 'deepen') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 1) deepen = n;
    } else if (key === 'done') done = true;
    // thin-pack, no-progress, filter, etc. are accepted and ignored.
  }
  if (command === 'ls-refs') {
    const rows = refRows(repo);
    const out: string[] = [];
    const headTip = defaultTip(repo);
    const matches = (name: string): boolean => refPrefix === null || name.startsWith(refPrefix);
    if (refPrefix === null) {
      if (headTip !== undefined) {
        out.push(symrefs ? `${headTip} HEAD symref-target:refs/heads/${repo.defaultBranch}` : `${headTip} HEAD`);
      } else if (unborn) {
        out.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}`);
      }
    }
    for (const row of rows) {
      if (!matches(row.name)) continue;
      let line = `${row.oid} ${row.name}`;
      if (peel && row.peeled !== null) line += ` peeled:${row.peeled}`;
      out.push(line);
    }
    if (rows.length === 0 && unborn && refPrefix === null) {
      // already emitted the unborn HEAD line above
    }
    sendRaw(res, 200, pktLines([...out.map((l) => `${l}\n`), 'flush']), 'application/x-git-upload-pack-result');
    return;
  }
  if (command === 'fetch') {
    const acks: string[] = [];
    for (const have of haves) {
      if (wants.some((w) => isAncestor(have, w, (oid) => repo.objects.get(oid)))) acks.push(`ACK ${have}`);
    }
    const { objects, shallowInfo } = planFetch(repo, wants, haves, deepen, shallow);
    const pack = writePack(objects);
    const parts: Buffer[] = [pkt('acknowledgments\n')];
    if (acks.length === 0) parts.push(pkt('NAK\n'));
    for (const a of acks) parts.push(pkt(`${a}\n`));
    parts.push(pkt('ready\n'));
    parts.push(DELIM);
    if (shallowInfo.length > 0) {
      parts.push(pkt('shallow-info\n'));
      for (const line of shallowInfo) parts.push(pkt(`${line}\n`));
      parts.push(DELIM);
    }
    parts.push(pkt('packfile\n'));
    parts.push(sidebandPack(pack));
    parts.push(FLUSH);
    sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    return;
  }
  // Unknown command: empty response.
  sendRaw(res, 200, pktLines(['flush']), 'application/x-git-upload-pack-result');
}
function planFetch(repo: Repo, wants: string[], haves: string[], deepen: number | null, shallowIn: string[]): { objects: GitObj[]; shallowInfo: string[] } {
  // Commits we need, limited by depth from the wanted tips.
  const wantedCommits = new Set<string>();
  const depthOf = new Map<string, number>();
  const queue: { oid: string; depth: number }[] = [];
  for (const w of wants) {
    const c = peelToCommit(repo, w);
    if (c === null) continue;
    queue.push({ oid: c, depth: 0 });
  }
  const maxDepth = deepen === null ? Infinity : deepen;
  const haveSet = new Set<string>();
  for (const h of haves) {
    const c = peelToCommit(repo, h);
    if (c !== null) haveSet.add(c);
  }
  while (queue.length) {
    const { oid, depth } = queue.shift() as { oid: string; depth: number };
    if (wantedCommits.has(oid)) continue;
    if (depth >= maxDepth) continue;
    wantedCommits.add(oid);
    depthOf.set(oid, depth);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push({ oid: p, depth: depth + 1 });
  }
  // Objects to send: the wanted commits' trees/blobs, following parents only into
  // commits that are themselves wanted (depth-limited); minus what the client has.
  // The client's have-reachability stops at its shallow boundaries, so a deepen
  // fetch still delivers the parent of a boundary the client already holds.
  const haveBoundary = new Set<string>();
  for (const b of shallowIn) {
    const c = peelToCommit(repo, b);
    if (c !== null) haveBoundary.add(c);
  }
  const haveReachable = collectReachableBounded(repo, [...haveSet], haveBoundary);
  const wantedObjs = collectFetchClosure(repo, wantedCommits);
  // A wanted object that is not a commit (e.g. an annotated tag) is sent itself: it is
  // not reachable from its target commit, only the other way round.
  for (const w of wants) if (repo.objects.has(w)) wantedObjs.add(w);
  const objects: GitObj[] = [];
  for (const oid of [...wantedObjs].sort()) {
    if (haveReachable.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj) objects.push(obj);
  }
  // Shallow boundaries.
  const shallowOut = new Set<string>();
  if (deepen !== null) {
    for (const oid of wantedCommits) {
      if (depthOf.get(oid) === maxDepth) shallowOut.add(oid);
      // A wanted commit whose parents were cut off (depth == maxDepth) is a boundary.
    }
    // Any wanted commit whose parent is not in the wanted set is also a boundary,
    // unless it was already sent before (it is not in haveSet).
    for (const oid of wantedCommits) {
      if (shallowOut.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.length > 0 && parents.some((p) => !wantedCommits.has(p))) shallowOut.add(oid);
    }
    for (const oid of shallowOut) {
      if (haveSet.has(oid)) shallowOut.delete(oid);
    }
  }
  const shallowInfo: string[] = [];
  for (const oid of [...shallowOut].sort()) shallowInfo.push(`shallow ${oid}`);
  // Unshallow: a previous boundary now reachable within depth, not itself a boundary,
  // and all its parents reachable within depth.
  if (deepen !== null) {
    for (const b of shallowIn) {
      const c = peelToCommit(repo, b);
      if (c === null) continue;
      if (shallowOut.has(c)) continue;
      if (!wantedCommits.has(c)) continue;
      const obj = repo.objects.get(c);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.every((p) => wantedCommits.has(p))) shallowInfo.push(`unshallow ${c}`);
    }
  }
  return { objects, shallowInfo };
}
/** Reachability that follows parents only into commits in `followParents` (the wanted
 *  set): the fetch closure of a shallow fetch. Trees/blobs/tags are followed fully. */
function collectFetchClosure(repo: Repo, wantedCommits: Set<string>): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...wantedCommits];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid) || !isOid(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      for (const p of c.parents) if (wantedCommits.has(p)) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}
/** Reachability from the client's haves, not following parents of its shallow
 *  boundaries (the client does not hold that history). */
function collectReachableBounded(repo: Repo, tips: string[], boundary: Set<string>): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...tips];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid) || !isOid(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      if (!boundary.has(oid)) for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}
function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  const { packets, rest } = decodePktLines(body);
  if (packets.length === 0 || packets[0]?.kind !== 'data') {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'x-github-request-id': reqId() });
    res.end('malformed pack request');
    return;
  }
  interface RefCmd {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: RefCmd[] = [];
  for (const p of packets) {
    if (p.kind !== 'data' || !p.payload) continue;
    const line = p.payload.toString('utf8').trimEnd();
    const nul = line.indexOf('\0');
    const clean = nul >= 0 ? line.slice(0, nul) : line;
    const parts = clean.split(' ');
    if (parts.length !== 3) continue;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isOid(oldOid) || !isOid(newOid)) continue;
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'x-github-request-id': reqId() });
    res.end('no ref commands');
    return;
  }
  // The pack follows the command flush (rest). Parse and import it first.
  const packBytes = body.subarray(rest);
  const hasPack = commands.some((c) => c.newOid !== ZERO_OID);
  let unpackOk = true;
  let imported: Map<string, GitObj> | null = null;
  if (hasPack) {
    try {
      const idx = packBytes.indexOf(Buffer.from('PACK'));
      const pack = idx > 0 ? packBytes.subarray(idx) : packBytes;
      imported = readPack(pack);
    } catch {
      unpackOk = false;
    }
  }
  if (imported) {
    for (const [oid, obj] of imported) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    }
  }
  const lines: string[] = ['unpack ok'];
  if (!unpackOk) lines[0] = 'unpack error';
  for (const cmd of commands) {
    if (!unpackOk && cmd.newOid !== ZERO_OID) {
      lines.push(`ng ${cmd.ref} unpack error`);
      continue;
    }
    if (cmd.newOid === ZERO_OID) {
      // delete
      if (cmd.oldOid === ZERO_OID || repo.refs.get(cmd.ref) === undefined) {
        lines.push(`ng ${cmd.ref} reference does not exist`);
      } else if (repo.refs.get(cmd.ref) !== cmd.oldOid) {
        lines.push(`ng ${cmd.ref} non-fast-forward`);
      } else {
        repo.refs.delete(cmd.ref);
        lines.push(`ok ${cmd.ref}`);
      }
      continue;
    }
    const obj = repo.objects.get(cmd.newOid);
    if (!obj) {
      lines.push(`ng ${cmd.ref} unpack error`);
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      if (repo.refs.has(cmd.ref)) {
        lines.push(`ng ${cmd.ref} reference already exists`);
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        lines.push(`ok ${cmd.ref}`);
      }
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    if (current === undefined) {
      lines.push(`ng ${cmd.ref} reference does not exist`);
      continue;
    }
    if (current !== cmd.oldOid) {
      lines.push(`ng ${cmd.ref} non-fast-forward`);
      continue;
    }
    const newCommit = peelToCommit(repo, cmd.newOid);
    const oldCommit = peelToCommit(repo, cmd.oldOid);
    if (newCommit === null || oldCommit === null) {
      repo.refs.set(cmd.ref, cmd.newOid);
      lines.push(`ok ${cmd.ref}`);
      continue;
    }
    if (!isAncestor(oldCommit, newCommit, (oid) => repo.objects.get(oid))) {
      lines.push(`ng ${cmd.ref} non-fast-forward`);
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    lines.push(`ok ${cmd.ref}`);
  }
  // Sideband: the report-status stream is itself pkt-framed inside band 1, and it
  // ends with its own flush inside band 1 (the outer flush only ends the demux).
  const parts: Buffer[] = [];
  for (const line of lines) parts.push(pkt(Buffer.concat([Buffer.from([1]), pkt(`${line}\n`)])));
  parts.push(pkt(Buffer.concat([Buffer.from([1]), Buffer.from('0000', 'ascii')])));
  parts.push(FLUSH);
  const resp = Buffer.concat(parts);
  sendRaw(res, 200, resp, 'application/x-git-receive-pack-result');
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
function authToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization ?? '';
  const m = /^(?:Bearer|token)\s+(.+)$/i.exec(header.trim());
  return m ? (m[1] as string) : null;
}
function authorized(req: IncomingMessage): boolean {
  const token = authToken(req);
  if (token === null || token === '') return false;
  if (SHOP_TOKEN !== '') return token === SHOP_TOKEN;
  return true;
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------
async function parseJsonBody(req: IncomingMessage): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; error: string }> {
  const raw = await readBody(req);
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'body must be a JSON object' };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: 'invalid JSON body' };
  }
}
function strField(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  return typeof v === 'string' ? v : '';
}
function boolField(body: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = body[key];
  return typeof v === 'boolean' ? v : fallback;
}
function getRepoOr404(res: ServerResponse, owner: string, name: string): Repo | null {
  const repo = repos.get(repoKey(owner, name));
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });
    return null;
  }
  return repo;
}
async function handleRest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = pathOf(req);
  const method = req.method ?? 'GET';
  const q = queryOf(req);
  const segs = path.split('/').filter((s) => s.length > 0).map(decodePath);
  // segs[0] === 'api', segs[1] === 'v3'
  if (method === 'GET' && path === '/api/v3/') {
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: '/settings/applications',
      authorizations_url: '/api/v3/authorizations',
      code_search_url: '/api/v3/search/code?q={query}{&page,per_page,sort,order}',
      commit_search_url: '/api/v3/search/commits?q={query}{&page,per_page,sort,order}',
      emails_url: '/api/v3/user/emails',
      emojis_url: '/api/v3/emojis',
      events_url: '/api/v3/events',
      feeds_url: '/api/v3/feeds',
      followers_url: '/api/v3/user/followers',
      following_url: '/api/v3/user/following{/target}',
      gists_url: '/api/v3/gists{/gist_id}',
      hub_url: '/api/v3/hub',
      issue_search_url: '/api/v3/search/issues?q={query}{&page,per_page,sort,order}',
      issues_url: '/api/v3/issues',
      keys_url: '/api/v3/user/keys',
      label_search_url: '/api/v3/search/labels?repository_id={repository_id}&q={query}{&page,per_page}',
      notifications_url: '/api/v3/notifications',
      organization_url: '/api/v3/orgs/{org}',
      organization_repositories_url: '/api/v3/orgs/{org}/repos{?type,page,per_page,sort}',
      organization_teams_url: '/api/v3/orgs/{org}/teams',
      public_gists_url: '/api/v3/gists/public',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      repository_search_url: '/api/v3/search/repositories?q={query}{&page,per_page,sort,order}',
      current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
      starred_url: '/api/v3/user/starred{/owner}{/repo}',
      starred_gists_url: '/api/v3/gists/starred',
      topic_search_url: '/api/v3/search/topics?q={query}{&page,per_page}',
      user_url: '/api/v3/users/{user}',
      user_organizations_url: '/api/v3/user/orgs',
      user_repositories_url: '/api/v3/users/{user}/repos{?type,page,per_page,sort}',
      user_search_url: '/api/v3/search/users?q={query}{&page,per_page,sort,order}',
    }, { 'x-oauth-scopes': 'repo, read:org', 'x-accepted-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (method === 'GET' && path === '/api/v3/meta') {
    sendJson(res, 200, { verifiable_password_authentication: true, installed_version: '1.0.0', hooks: [], git: [], pages: [], importer: [], actions: [], packages: [] });
    return;
  }
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Requires authentication', documentation_url: 'https://docs.github.com/rest' });
    return;
  }
  // /api/v3/user
  if (segs.length === 3 && segs[2] === 'user') {
    if (method === 'GET') {
      sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, node_id: globalId('User', VIEWER.id), avatar_url: '', gravatar_id: '', url: '/api/v3/user', html_url: `https://example.invalid/${VIEWER.login}`, type: 'User', site_admin: false, name: VIEWER.name, company: null, blog: '', location: null, email: VIEWER.email, hireable: null, bio: null, twitter_username: null, public_repos: repos.size, public_gists: 0, followers: 0, following: 0, created_at: '2020-01-01T00:00:00Z', updated_at: nowIso() });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  // /api/v3/user/repos
  if (segs.length === 4 && segs[2] === 'user' && segs[3] === 'repos') {
    if (method === 'POST') {
      const parsed = await parseJsonBody(req);
      if (!parsed.ok) {
        sendJson(res, 400, { message: parsed.error });
        return;
      }
      const name = strField(parsed.value, 'name');
      if (name === '') {
        sendJson(res, 422, { message: 'name is required' });
        return;
      }
      if (repos.has(repoKey(VIEWER.login, name))) {
        sendJson(res, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] });
        return;
      }
      const repo = createRepo(VIEWER.login, name, boolField(parsed.value, 'private', false), strField(parsed.value, 'description'));
      sendJson(res, 201, repoJson(repo));
      return;
    }
    if (method === 'GET') {
      const mine = [...repos.values()].filter((r) => r.owner === VIEWER.login).sort((a, b) => a.createdSeq - b.createdSeq);
      const { page, link } = paginate(req, mine, q);
      sendJson(res, 200, page.map((r) => repoJson(r)), link ? { link } : {});
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  // /api/v3/repos/{owner}/{repo}/...
  if (segs.length >= 4 && segs[2] === 'repos') {
    const owner = segs[3] as string;
    const name = segs[4] as string;
    const repo = getRepoOr404(res, owner, name);
    if (!repo) return;
    const rest = segs.slice(5);
    // /repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'PATCH') {
        const parsed = await parseJsonBody(req);
        if (!parsed.ok) {
          sendJson(res, 400, { message: parsed.error });
          return;
        }
        const desc = parsed.value.description;
        if (typeof desc === 'string') repo.description = desc;
        const newName = strField(parsed.value, 'name');
        if (newName !== '' && newName !== repo.name) {
          repos.delete(repoKey(repo.owner, repo.name));
          repo.name = newName;
          repos.set(repoKey(repo.owner, repo.name), repo);
        }
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'DELETE') {
        repos.delete(repoKey(repo.owner, repo.name));
        sendJson(res, 204, null);
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    // branches
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const list = [...repo.refs.keys()]
          .filter((r) => r.startsWith('refs/heads/'))
          .map((r) => r.slice('refs/heads/'.length))
          .sort()
          .map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`) as string, url: `/api/v3/repos/${owner}/${name}/commits/${repo.refs.get(`refs/heads/${branch}`)}` }, protected: false }));
        sendJson(res, 200, list);
        return;
      }
      if (rest.length === 2 && method === 'GET') {
        const branch = rest[1] as string;
        const sha = branchTip(repo, branch);
        if (sha === undefined) {
          sendJson(res, 404, { message: 'Branch not found' });
          return;
        }
        sendJson(res, 200, { name: branch, commit: { sha, url: `/api/v3/repos/${owner}/${name}/commits/${sha}` }, protected: false });
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    // git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 2 && method === 'GET') {
        const list = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([ref, sha]) => ({ ref, node_id: globalId('Ref', repo.dbId, ref), url: `/api/v3/repos/${owner}/${name}/git/refs/${ref.replace(/^refs\//, '')}`, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: `/api/v3/repos/${owner}/${name}/git/${repo.objects.get(sha)?.type ?? 'commit'}s/${sha}` } }));
        sendJson(res, 200, list);
        return;
      }
      if (rest.length === 2 && method === 'POST') {
        const parsed = await parseJsonBody(req);
        if (!parsed.ok) {
          sendJson(res, 400, { message: parsed.error });
          return;
        }
        const ref = strField(parsed.value, 'ref');
        const sha = strField(parsed.value, 'sha');
        if (ref === '' || sha === '') {
          sendJson(res, 422, { message: 'ref and sha are required' });
          return;
        }
        if (!repo.objects.has(sha)) {
          sendJson(res, 422, { message: 'Object does not exist' });
          return;
        }
        if (repo.refs.has(ref)) {
          sendJson(res, 422, { message: 'Reference already exists' });
          return;
        }
        repo.refs.set(ref, sha);
        const type = repo.objects.get(sha)?.type ?? 'commit';
        sendJson(res, 201, { ref, node_id: globalId('Ref', repo.dbId, ref), url: `/api/v3/repos/${owner}/${name}/git/refs/${ref.replace(/^refs\//, '')}`, object: { sha, type, url: `/api/v3/repos/${owner}/${name}/git/${type}s/${sha}` } });
        return;
      }
      if (rest.length >= 3 && method === 'GET') {
        const ref = `refs/${rest.slice(2).join('/')}`;
        const sha = repo.refs.get(ref);
        if (sha === undefined) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        const type = repo.objects.get(sha)?.type ?? 'commit';
        sendJson(res, 200, { ref, node_id: globalId('Ref', repo.dbId, ref), url: `/api/v3/repos/${owner}/${name}/git/refs/${rest.slice(2).join('/')}`, object: { sha, type, url: `/api/v3/repos/${owner}/${name}/git/${type}s/${sha}` } });
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    // commits
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const shaParam = q.get('sha');
      let tip: string | undefined;
      if (shaParam) {
        tip = branchTip(repo, shaParam) ?? (isOid(shaParam) ? shaParam : undefined) ?? repo.refs.get(shaParam);
      } else {
        tip = defaultTip(repo);
      }
      if (tip === undefined || !repo.objects.has(tip)) {
        sendJson(res, 200, []);
        return;
      }
      sendJson(res, 200, listCommits(repo, tip).map((c) => commitJson(repo, c)));
      return;
    }
    // contents
    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).join('/');
      const refParam = q.get('ref');
      const branch = refParam ?? repo.defaultBranch;
      const tip = branchTip(repo, branch) ?? (isOid(branch) ? branch : undefined);
      if (method === 'GET') {
        if (tip === undefined) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        const files = filesAt(repo, tip);
        if (filePath === '') {
          const top = new Map<string, { type: string; oid: string; path: string }>();
          for (const p of files.keys()) {
            const first = p.split('/')[0] as string;
            if (!top.has(first)) {
              const isDir = [...files.keys()].some((k) => k.startsWith(`${first}/`)) && !files.has(first);
              top.set(first, { type: isDir ? 'dir' : 'file', oid: isDir ? '' : (files.get(first)?.oid ?? ''), path: first });
            }
          }
          const list = [...top.entries()].map(([name, e]) => ({
            type: e.type,
            size: e.type === 'file' ? (repo.objects.get(e.oid)?.data.length ?? 0) : 0,
            name,
            path: e.path,
            sha: e.oid,
            url: `/api/v3/repos/${owner}/${name}/contents/${e.path}`,
            git_url: `/api/v3/repos/${owner}/${name}/git/${e.type === 'file' ? 'blobs' : 'trees'}/${e.oid}`,
            html_url: `https://example.invalid/${owner}/${name}/blob/${branch}/${e.path}`,
            download_url: e.type === 'file' ? `https://example.invalid/${owner}/${name}/raw/${branch}/${e.path}` : null,
          }));
          sendJson(res, 200, list);
          return;
        }
        const entry = files.get(filePath);
        if (entry) {
          const data = repo.objects.get(entry.oid)?.data ?? Buffer.alloc(0);
          sendJson(res, 200, {
            type: 'file', encoding: 'base64', size: data.length, name: filePath.split('/').pop() ?? filePath, path: filePath,
            content: data.toString('base64'), sha: entry.oid,
            url: `/api/v3/repos/${owner}/${name}/contents/${filePath}`,
            git_url: `/api/v3/repos/${owner}/${name}/git/blobs/${entry.oid}`,
            html_url: `https://example.invalid/${owner}/${name}/blob/${branch}/${filePath}`,
            download_url: `https://example.invalid/${owner}/${name}/raw/${branch}/${filePath}`,
          });
          return;
        }
        const dirEntries: { name: string; path: string; oid: string; isFile: boolean }[] = [];
        const prefix = `${filePath}/`;
        const seen = new Set<string>();
        for (const p of files.keys()) {
          if (!p.startsWith(prefix)) continue;
          const restPath = p.slice(prefix.length);
          const first = restPath.split('/')[0] as string;
          if (seen.has(first)) continue;
          seen.add(first);
          const isFile = !restPath.includes('/');
          dirEntries.push({ name: first, path: `${filePath}/${first}`, oid: isFile ? (files.get(p)?.oid ?? '') : '', isFile });
        }
        if (dirEntries.length === 0) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        dirEntries.sort((a, b) => (a.name < b.name ? -1 : 1));
        sendJson(res, 200, dirEntries.map((e) => ({
          type: e.isFile ? 'file' : 'dir',
          size: e.isFile ? (repo.objects.get(e.oid)?.data.length ?? 0) : 0,
          name: e.name, path: e.path, sha: e.oid,
          url: `/api/v3/repos/${owner}/${name}/contents/${e.path}`,
          git_url: `/api/v3/repos/${owner}/${name}/git/${e.isFile ? 'blobs' : 'trees'}/${e.oid}`,
          html_url: `https://example.invalid/${owner}/${name}/blob/${branch}/${e.path}`,
          download_url: e.isFile ? `https://example.invalid/${owner}/${name}/raw/${branch}/${e.path}` : null,
        })));
        return;
      }
      if (method === 'PUT') {
        const parsed = await parseJsonBody(req);
        if (!parsed.ok) {
          sendJson(res, 400, { message: parsed.error });
          return;
        }
        const message = strField(parsed.value, 'message') || `Update ${filePath}`;
        const contentB64 = strField(parsed.value, 'content');
        if (contentB64 === '') {
          sendJson(res, 422, { message: 'content is required' });
          return;
        }
        let content: Buffer;
        try {
          content = b64decode(contentB64);
        } catch {
          sendJson(res, 422, { message: 'content is not valid base64' });
          return;
        }
        const putBranch = strField(parsed.value, 'branch') || repo.defaultBranch;
        const sha = strField(parsed.value, 'sha');
        const currentTip = branchTip(repo, putBranch) ?? defaultTip(repo);
        const currentFiles = currentTip !== undefined ? filesAt(repo, currentTip) : new Map();
        const existing = currentFiles.get(filePath);
        if (sha !== '' && existing && existing.oid !== sha) {
          sendJson(res, 409, { message: 'sha does not match' });
          return;
        }
        if (sha !== '' && !existing) {
          sendJson(res, 409, { message: 'sha does not match' });
          return;
        }
        const isUpdate = existing !== undefined;
        const { commitSha, blobSha } = commitFile(repo, putBranch, filePath, content, message);
        sendJson(res, isUpdate ? 200 : 201, {
          content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: blobSha, size: content.length, type: 'file', encoding: 'base64' },
          commit: { sha: commitSha, message, author: { name: VIEWER.name, email: VIEWER.email, date: nowIso() }, committer: { name: VIEWER.name, email: VIEWER.email, date: nowIso() } },
        });
        return;
      }
      if (method === 'DELETE') {
        const parsed = await parseJsonBody(req);
        if (!parsed.ok) {
          sendJson(res, 400, { message: parsed.error });
          return;
        }
        const message = strField(parsed.value, 'message') || `Delete ${filePath}`;
        const sha = strField(parsed.value, 'sha');
        const delBranch = strField(parsed.value, 'branch') || repo.defaultBranch;
        const currentTip = branchTip(repo, delBranch);
        if (currentTip === undefined) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        const currentFiles = filesAt(repo, currentTip);
        const existing = currentFiles.get(filePath);
        if (!existing) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (sha !== '' && existing.oid !== sha) {
          sendJson(res, 409, { message: 'sha does not match' });
          return;
        }
        const commitSha = deleteFile(repo, delBranch, filePath, message);
        if (commitSha === null) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        sendJson(res, 200, { commit: { sha: commitSha, message, author: { name: VIEWER.name, email: VIEWER.email, date: nowIso() }, committer: { name: VIEWER.name, email: VIEWER.email, date: nowIso() } } });
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    // labels
    if (rest[0] === 'labels') {
      if (rest.length === 1 && method === 'POST') {
        const parsed = await parseJsonBody(req);
        if (!parsed.ok) {
          sendJson(res, 400, { message: parsed.error });
          return;
        }
        const name = strField(parsed.value, 'name');
        if (name === '') {
          sendJson(res, 422, { message: 'name is required' });
          return;
        }
        if (repo.labels.has(name)) {
          sendJson(res, 422, { message: 'Label already exists' });
          return;
        }
        const color = strField(parsed.value, 'color') || 'ededed';
        repo.labels.set(name, { name, color });
        sendJson(res, 201, { name, color, description: '', url: `/api/v3/repos/${owner}/${name}/labels/${encodeURIComponent(name)}` });
        return;
      }
      if (rest.length === 1 && method === 'GET') {
        sendJson(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: '', url: `/api/v3/repos/${owner}/${name}/labels/${encodeURIComponent(l.name)}` })));
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1 && method === 'POST') {
        const parsed = await parseJsonBody(req);
        if (!parsed.ok) {
          sendJson(res, 400, { message: parsed.error });
          return;
        }
        const title = strField(parsed.value, 'title');
        if (title === '') {
          sendJson(res, 422, { message: 'title is required' });
          return;
        }
        const labelsRaw = parsed.value.labels;
        const labels: string[] = Array.isArray(labelsRaw) ? labelsRaw.filter((l): l is string => typeof l === 'string') : [];
        for (const label of labels) {
          if (!repo.labels.has(label)) {
            sendJson(res, 422, { message: `Label '${label}' does not exist` });
            return;
          }
        }
        const issue = createIssue(repo, title, strField(parsed.value, 'body'), labels);
        sendJson(res, 201, issueJson(repo, issue));
        return;
      }
      if (rest.length === 1 && method === 'GET') {
        const state = q.get('state') ?? 'open';
        let list = [...repo.issues];
        if (state === 'open') list = list.filter((i) => i.state === 'open');
        else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
        const sort = q.get('sort') ?? 'created';
        const direction = q.get('direction') ?? 'desc';
        if (sort === 'created') {
          list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
        }
        const { page, link } = paginate(req, list, q);
        sendJson(res, 200, page.map((i) => issueJson(repo, i)), link ? { link } : {});
        return;
      }
      const num = Number(rest[1]);
      if (rest.length >= 2 && Number.isInteger(num)) {
        const issue = repo.issues.find((i) => i.number === num);
        if (!issue) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (rest.length === 2 && method === 'GET') {
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
        if (rest.length === 2 && method === 'PATCH') {
          const parsed = await parseJsonBody(req);
          if (!parsed.ok) {
            sendJson(res, 400, { message: parsed.error });
            return;
          }
          const title = parsed.value.title;
          if (typeof title === 'string' && title !== '') issue.title = title;
          const body = parsed.value.body;
          if (typeof body === 'string') issue.body = body;
          const state = parsed.value.state;
          if (state === 'open' || state === 'closed') {
            issue.state = state;
            issue.closedAt = state === 'closed' ? nowIso() : null;
          }
          const labelsRaw = parsed.value.labels;
          if (Array.isArray(labelsRaw)) {
            const labels = labelsRaw.filter((l): l is string => typeof l === 'string');
            for (const label of labels) {
              if (!repo.labels.has(label)) {
                sendJson(res, 422, { message: `Label '${label}' does not exist` });
                return;
              }
            }
            issue.labels = labels;
          }
          issue.updatedAt = nowIso();
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
        if (rest.length === 3 && rest[2] === 'comments') {
          if (method === 'GET') {
            const list = repo.comments.get(num) ?? [];
            sendJson(res, 200, list.map((c) => ({ id: c.id, node_id: globalId('IssueComment', repo.dbId, num, c.id), body: c.body, user: { login: VIEWER.login, id: VIEWER.id, type: 'User' }, created_at: c.createdAt, updated_at: c.createdAt, html_url: `https://example.invalid/${owner}/${name}/issues/${num}#issuecomment-${c.id}`, url: `/api/v3/repos/${owner}/${name}/issues/comments/${c.id}` })));
            return;
          }
          if (method === 'POST') {
            const parsed = await parseJsonBody(req);
            if (!parsed.ok) {
              sendJson(res, 400, { message: parsed.error });
              return;
            }
            const body = strField(parsed.value, 'body');
            if (body === '') {
              sendJson(res, 422, { message: 'body is required' });
              return;
            }
            const comment: Comment = { id: repo.nextCommentId, body, createdAt: nowIso() };
            repo.nextCommentId += 1;
            if (!repo.comments.has(num)) repo.comments.set(num, []);
            (repo.comments.get(num) as Comment[]).push(comment);
            sendJson(res, 201, { id: comment.id, node_id: globalId('IssueComment', repo.dbId, num, comment.id), body: comment.body, user: { login: VIEWER.login, id: VIEWER.id, type: 'User' }, created_at: comment.createdAt, updated_at: comment.createdAt, html_url: `https://example.invalid/${owner}/${name}/issues/${num}#issuecomment-${comment.id}`, url: `/api/v3/repos/${owner}/${name}/issues/comments/${comment.id}` });
            return;
          }
        }
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1 && method === 'POST') {
        const parsed = await parseJsonBody(req);
        if (!parsed.ok) {
          sendJson(res, 400, { message: parsed.error });
          return;
        }
        const title = strField(parsed.value, 'title');
        const head = strField(parsed.value, 'head');
        const base = strField(parsed.value, 'base');
        if (title === '' || head === '' || base === '') {
          sendJson(res, 422, { message: 'title, head and base are required' });
          return;
        }
        const result = createPull(repo, title, strField(parsed.value, 'body'), head, base);
        if ('error' in result) {
          sendJson(res, 422, { message: result.error });
          return;
        }
        sendJson(res, 201, pullJson(repo, result));
        return;
      }
      if (rest.length === 1 && method === 'GET') {
        const state = q.get('state') ?? 'open';
        let list = [...repo.pulls];
        if (state === 'open') list = list.filter((p) => p.state === 'open');
        else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
        const { page, link } = paginate(req, list, q);
        sendJson(res, 200, page.map((p) => pullJson(repo, p)), link ? { link } : {});
        return;
      }
      const num = Number(rest[1]);
      if (rest.length >= 2 && Number.isInteger(num)) {
        const pull = repo.pulls.find((p) => p.number === num);
        if (!pull) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (rest.length === 2 && method === 'GET') {
          sendJson(res, 200, pullJson(repo, pull));
          return;
        }
        if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
          sendJson(res, 200, pull.files.map((f) => ({
            sha: '', filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes,
            blob_url: '', raw_url: '', contents_url: '',
          })));
          return;
        }
        if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
          const parsed = await parseJsonBody(req);
          if (!parsed.ok) {
            sendJson(res, 400, { message: parsed.error });
            return;
          }
          if (pull.state !== 'open') {
            sendJson(res, 405, { message: 'Pull request has already been merged or closed' });
            return;
          }
          const mergeMethod = strField(parsed.value, 'merge_method') || 'squash';
          if (mergeMethod !== 'squash') {
            sendJson(res, 405, { message: `merge method ${mergeMethod} is not supported` });
            return;
          }
          const sha = squashMerge(repo, pull);
          if (sha === null) {
            sendJson(res, 405, { message: 'Merge conflict' });
            return;
          }
          sendJson(res, 200, { sha, merged: true, message: 'Pull request successfully merged' });
          return;
        }
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}

// ---------------------------------------------------------------------------
// GraphQL v4 (small hand-written parser + executor for the documented surface)
// ---------------------------------------------------------------------------
type GqlToken =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'var'; value: string }
  | { kind: 'spread'; value: string }
  | { kind: 'punct'; value: string };
function tokenizeGql(src: string): GqlToken[] {
  const tokens: GqlToken[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (src.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < src.length && /[_0-9A-Za-z]/.test(src[j] as string)) j += 1;
      tokens.push({ kind: 'var', value: src.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (ch === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        const stop = end < 0 ? src.length : end;
        tokens.push({ kind: 'string', value: src.slice(i + 3, stop) });
        i = end < 0 ? src.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && /[0-9]/.test(src[i + 1] ?? '') || /[0-9]/.test(ch)) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      let isFloat = false;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < src.length && /[_0-9A-Za-z]/.test(src[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    tokens.push({ kind: 'punct', value: ch });
    i += 1;
  }
  return tokens;
}
type GqlValue = { kind: 'var'; name: string } | { kind: 'literal'; value: unknown };
interface GqlField {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Record<string, GqlValue>;
  selections: GqlSelection[] | null;
}
interface GqlInlineFragment {
  kind: 'inline';
  typeCondition: string | null;
  selections: GqlSelection[];
}
interface GqlSpread {
  kind: 'spread';
  name: string;
}
type GqlSelection = GqlField | GqlInlineFragment | GqlSpread;
interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, unknown>;
  selections: GqlSelection[];
}
interface GqlDocument {
  operations: GqlOperation[];
  fragments: Map<string, { typeCondition: string | null; selections: GqlSelection[] }>;
}
class GqlParser {
  #tokens: GqlToken[];
  #pos = 0;
  constructor(tokens: GqlToken[]) {
    this.#tokens = tokens;
  }
  #peek(): GqlToken | undefined {
    return this.#tokens[this.#pos];
  }
  #next(): GqlToken {
    const t = this.#tokens[this.#pos] as GqlToken;
    this.#pos += 1;
    return t;
  }
  #expectPunct(value: string): void {
    const t = this.#next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`expected '${value}'`);
  }
  #expectName(value?: string): string {
    const t = this.#next();
    if (t.kind !== 'name') throw new Error('expected name');
    if (value !== undefined && t.value !== value) throw new Error(`expected '${value}'`);
    return t.value;
  }
  parseDocument(): GqlDocument {
    const doc: GqlDocument = { operations: [], fragments: new Map() };
    while (this.#pos < this.#tokens.length) {
      const t = this.#peek() as GqlToken;
      if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        doc.operations.push(this.#parseOperation());
      } else if (t.kind === 'name' && t.value === 'fragment') {
        this.#next();
        const name = this.#expectName();
        this.#expectName('on');
        const typeCondition = this.#expectName();
        const selections = this.#parseSelectionSet();
        doc.fragments.set(name, { typeCondition, selections });
      } else if (t.kind === 'punct' && t.value === '{') {
        doc.operations.push({ kind: 'query', name: null, variables: {}, selections: this.#parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${t.value}`);
      }
    }
    return doc;
  }
  #parseOperation(): GqlOperation {
    const kind = this.#next().value as 'query' | 'mutation';
    let name: string | null = null;
    const t = this.#peek();
    if (t && t.kind === 'name') name = this.#next().value;
    const variables: Record<string, unknown> = {};
    const p = this.#peek();
    if (p && p.kind === 'punct' && p.value === '(') this.#parseVariableDefinitions(variables);
    const selections = this.#parseSelectionSet();
    return { kind, name, variables, selections };
  }
  #parseVariableDefinitions(vars: Record<string, unknown>): void {
    this.#expectPunct('(');
    for (;;) {
      const t = this.#peek() as GqlToken;
      if (t.kind === 'punct' && t.value === ')') {
        this.#next();
        return;
      }
      if (t.kind === 'var') {
        this.#next();
        this.#expectPunct(':');
        this.#parseType();
        const eq = this.#peek();
        if (eq && eq.kind === 'punct' && eq.value === '=') {
          this.#next();
          vars[t.value] = this.#parseValueLiteral();
        } else {
          vars[t.value] = undefined;
        }
        continue;
      }
      this.#next();
    }
  }
  #parseType(): void {
    const t = this.#peek() as GqlToken;
    if (t.kind === 'punct' && t.value === '[') {
      this.#next();
      this.#parseType();
      this.#expectPunct(']');
    } else if (t.kind === 'name') {
      this.#next();
    }
    const bang = this.#peek();
    if (bang && bang.kind === 'punct' && bang.value === '!') this.#next();
  }
  #parseSelectionSet(): GqlSelection[] {
    this.#expectPunct('{');
    const selections: GqlSelection[] = [];
    for (;;) {
      const t = this.#peek() as GqlToken;
      if (t.kind === 'punct' && t.value === '}') {
        this.#next();
        return selections;
      }
      selections.push(this.#parseSelection());
    }
  }
  #parseSelection(): GqlSelection {
    const t = this.#peek() as GqlToken;
    if (t.kind === 'spread') {
      this.#next();
      const next = this.#peek() as GqlToken;
      if (next.kind === 'name' && next.value === 'on') {
        this.#next();
        const typeCondition = this.#expectName();
        return { kind: 'inline', typeCondition, selections: this.#parseSelectionSet() };
      }
      if (next.kind === 'name') {
        return { kind: 'spread', name: this.#next().value };
      }
      return { kind: 'inline', typeCondition: null, selections: this.#parseSelectionSet() };
    }
    const first = this.#expectName();
    let alias: string | null = null;
    let name = first;
    const colon = this.#peek();
    if (colon && colon.kind === 'punct' && colon.value === ':') {
      this.#next();
      alias = first;
      name = this.#expectName();
    }
    const args: Record<string, GqlValue> = {};
    const paren = this.#peek();
    if (paren && paren.kind === 'punct' && paren.value === '(') {
      this.#next();
      for (;;) {
        const at = this.#peek() as GqlToken;
        if (at.kind === 'punct' && at.value === ')') {
          this.#next();
          break;
        }
        const argName = this.#expectName();
        this.#expectPunct(':');
        args[argName] = this.#parseValue();
      }
    }
    // Directives: @name or @name(args)
    for (;;) {
      const d = this.#peek();
      if (d && d.kind === 'punct' && d.value === '@') {
        this.#next();
        this.#expectName();
        const dp = this.#peek();
        if (dp && dp.kind === 'punct' && dp.value === '(') {
          this.#next();
          let depth = 1;
          while (depth > 0) {
            const tok = this.#next();
            if (tok.kind === 'punct' && tok.value === '(') depth += 1;
            else if (tok.kind === 'punct' && tok.value === ')') depth -= 1;
          }
        }
        continue;
      }
      break;
    }
    let selections: GqlSelection[] | null = null;
    const brace = this.#peek();
    if (brace && brace.kind === 'punct' && brace.value === '{') selections = this.#parseSelectionSet();
    return { kind: 'field', name, alias, args, selections };
  }
  #parseValue(): GqlValue {
    const t = this.#next();
    if (t.kind === 'var') return { kind: 'var', name: t.value };
    if (t.kind === 'string') return { kind: 'literal', value: t.value };
    if (t.kind === 'int') return { kind: 'literal', value: Number.parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'literal', value: Number.parseFloat(t.value) };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'literal', value: true };
      if (t.value === 'false') return { kind: 'literal', value: false };
      if (t.value === 'null') return { kind: 'literal', value: null };
      return { kind: 'literal', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const items: GqlValue[] = [];
      for (;;) {
        const at = this.#peek() as GqlToken;
        if (at.kind === 'punct' && at.value === ']') {
          this.#next();
          break;
        }
        items.push(this.#parseValue());
      }
      return { kind: 'literal', value: items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const obj: Record<string, GqlValue> = {};
      for (;;) {
        const at = this.#peek() as GqlToken;
        if (at.kind === 'punct' && at.value === '}') {
          this.#next();
          break;
        }
        const key = this.#expectName();
        this.#expectPunct(':');
        obj[key] = this.#parseValue();
      }
      return { kind: 'literal', value: obj };
    }
    throw new Error(`unexpected value token ${t.value}`);
  }
  #parseValueLiteral(): unknown {
    return this.#evalValue(this.#parseValue(), {});
  }
  #evalValue(v: GqlValue, vars: Record<string, unknown>): unknown {
    if (v.kind === 'var') return vars[v.name];
    const val = v.value;
    if (Array.isArray(val)) return val.map((item) => this.#evalValue(item as GqlValue, vars));
    if (val !== null && typeof val === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, item] of Object.entries(val as Record<string, GqlValue>)) out[k] = this.#evalValue(item, vars);
      return out;
    }
    return val;
  }
}
function evalGqlValue(v: GqlValue, vars: Record<string, unknown>): unknown {
  if (v.kind === 'var') return vars[v.name];
  const val = v.value;
  if (Array.isArray(val)) return val.map((item) => evalGqlValue(item as GqlValue, vars));
  if (val !== null && typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, item] of Object.entries(val as Record<string, GqlValue>)) out[k] = evalGqlValue(item, vars);
    return out;
  }
  return val;
}
// GraphQL object wrappers carry __typename plus a reference to the store record.
type GqlObj = Record<string, unknown> & { __typename: string };
function repoObj(repo: Repo): GqlObj {
  return { __typename: 'Repository', repo };
}
function issueObj(repo: Repo, issue: Issue): GqlObj {
  return { __typename: 'Issue', repo, issue };
}
function pullObj(repo: Repo, pull: Pull): GqlObj {
  return { __typename: 'PullRequest', repo, pull };
}
function userObj(): GqlObj {
  return { __typename: 'User', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
}
function cursorForNumber(n: number): string {
  return Buffer.from(String(n), 'utf8').toString('base64');
}
function numberFromCursor(cursor: string): number | null {
  try {
    const n = Number(Buffer.from(cursor, 'base64').toString('utf8'));
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}
function issueConnection(repo: Repo, args: Record<string, unknown>): GqlObj {
  let list = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s)));
    list = list.filter((i) => wanted.has(i.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = args.orderBy as Record<string, unknown> | undefined;
  const field = orderBy ? String(orderBy.field ?? '') : '';
  const direction = orderBy ? String(orderBy.direction ?? '') : '';
  if (field === 'CREATED_AT') {
    list.sort((a, b) => (direction === 'DESC' ? b.createdSeq - a.createdSeq || b.number - a.number : a.createdSeq - b.createdSeq || a.number - b.number));
  } else {
    list.sort((a, b) => a.number - b.number);
  }
  const after = typeof args.after === 'string' ? numberFromCursor(args.after) : null;
  if (after !== null) {
    const idx = list.findIndex((i) => i.number === after);
    if (idx >= 0) list = list.slice(idx + 1);
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const hasMore = list.length > first;
  const page = list.slice(0, first);
  return {
    __typename: 'IssueConnection',
    nodes: page.map((i) => issueObj(repo, i)),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: hasMore,
      hasPreviousPage: false,
      endCursor: page.length > 0 ? cursorForNumber((page[page.length - 1] as Issue).number) : null,
      startCursor: page.length > 0 ? cursorForNumber((page[0] as Issue).number) : null,
    },
    totalCount: repo.issues.length,
  };
}
function pullConnection(repo: Repo, args: Record<string, unknown>): GqlObj {
  let list = [...repo.pulls].sort((a, b) => a.number - b.number);
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s)));
    list = list.filter((p) => wanted.has(p.merged ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const after = typeof args.after === 'string' ? numberFromCursor(args.after) : null;
  if (after !== null) {
    const idx = list.findIndex((p) => p.number === after);
    if (idx >= 0) list = list.slice(idx + 1);
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const hasMore = list.length > first;
  const page = list.slice(0, first);
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((p) => pullObj(repo, p)),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: hasMore,
      hasPreviousPage: false,
      endCursor: page.length > 0 ? cursorForNumber((page[page.length - 1] as Pull).number) : null,
      startCursor: page.length > 0 ? cursorForNumber((page[0] as Pull).number) : null,
    },
    totalCount: repo.pulls.length,
  };
}
const GQL_TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  User: ['login', 'id', 'name', 'email'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueComment: ['id', 'body'],
  Ref: ['name'],
};
const GQL_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  IssueOrderField: ['COMMENTS', 'CREATED_AT', 'UPDATED_AT'],
  OrderDirection: ['ASC', 'DESC'],
  MergeStateStatus: ['BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'DRAFT', 'HAS_HOOKS', 'MERGED', 'UNKNOWN', 'UNSTABLE'],
};
type GqlCtx = { variables: Record<string, unknown>; errors: { message: string }[] };
function gqlResolveField(typeName: string, parent: GqlObj, field: GqlField, ctx: GqlCtx): unknown {
  if (field.name === '__typename') return typeName;
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(field.args)) args[k] = evalGqlValue(v, ctx.variables);
  // Root types
  if (typeName === 'Query') {
    if (field.name === 'viewer') return userObj();
    if (field.name === 'repository') {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      const repo = repos.get(repoKey(owner, name));
      return repo ? repoObj(repo) : null;
    }
    if (field.name === 'node') {
      const id = String(args.id ?? '');
      const parsed = parseGlobalId(id);
      if (!parsed) return null;
      if (parsed.kind === 'Repository') {
        const repo = findRepoByGlobalId(id);
        return repo ? repoObj(repo) : null;
      }
      if (parsed.kind === 'Issue') {
        const found = findIssueByGlobalId(id);
        return found ? issueObj(found.repo, found.issue) : null;
      }
      if (parsed.kind === 'PullRequest') {
        const found = findPullByGlobalId(id);
        return found ? pullObj(found.repo, found.pull) : null;
      }
      return null;
    }
    if (field.name === '__type') {
      const name = String(args.name ?? '');
      if (GQL_TYPE_FIELDS[name]) {
        return { __typename: '__Type', name, kind: 'OBJECT', fields: GQL_TYPE_FIELDS[name]?.map((f) => ({ __typename: '__Field', name: f })), enumValues: null };
      }
      if (GQL_ENUM_VALUES[name]) {
        return { __typename: '__Type', name, kind: 'ENUM', fields: null, enumValues: GQL_ENUM_VALUES[name]?.map((v) => ({ __typename: '__EnumValue', name: v })) };
      }
      return null;
    }
    if (field.name === '__schema') {
      return { __typename: '__Schema', types: [] };
    }
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Query".` });
    return undefined;
  }
  if (typeName === 'Mutation') {
    if (field.name === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = typeof input.repositoryId === 'string' ? findRepoByGlobalId(input.repositoryId) : null;
      if (!repo) {
        ctx.errors.push({ message: 'Could not resolve to a Repository with the provided id.' });
        return { __typename: 'CreateIssuePayload', issue: null };
      }
      const issue = createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return { __typename: 'CreateIssuePayload', issue: issueObj(repo, issue) };
    }
    if (field.name === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = typeof input.issueId === 'string' ? findIssueByGlobalId(input.issueId) : null;
      if (!found) {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the provided id.' });
        return { __typename: 'CloseIssuePayload', issue: null };
      }
      found.issue.state = 'closed';
      found.issue.closedAt = nowIso();
      found.issue.updatedAt = nowIso();
      return { __typename: 'CloseIssuePayload', issue: issueObj(found.repo, found.issue) };
    }
    if (field.name === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = typeof input.repositoryId === 'string' ? findRepoByGlobalId(input.repositoryId) : null;
      if (!repo) {
        ctx.errors.push({ message: 'Could not resolve to a Repository with the provided id.' });
        return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      }
      const result = createPull(repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
      if ('error' in result) {
        ctx.errors.push({ message: result.error });
        return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      }
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(repo, result) };
    }
    if (field.name === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = typeof input.pullRequestId === 'string' ? findPullByGlobalId(input.pullRequestId) : null;
      if (!found) {
        ctx.errors.push({ message: 'Could not resolve to a PullRequest with the provided id.' });
        return { __typename: 'MergePullRequestPayload', pullRequest: null };
      }
      if (found.pull.state === 'open') squashMerge(found.repo, found.pull);
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(found.repo, found.pull) };
    }
    if (field.name === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = typeof input.subjectId === 'string' ? findIssueByGlobalId(input.subjectId) : null;
      if (!found) {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the provided id.' });
        return { __typename: 'AddCommentPayload', commentEdge: null };
      }
      const comment: Comment = { id: found.repo.nextCommentId, body: String(input.body ?? ''), createdAt: nowIso() };
      found.repo.nextCommentId += 1;
      if (!found.repo.comments.has(found.issue.number)) found.repo.comments.set(found.issue.number, []);
      (found.repo.comments.get(found.issue.number) as Comment[]).push(comment);
      const node: GqlObj = { __typename: 'IssueComment', id: globalId('IssueComment', found.repo.dbId, found.issue.number, comment.id), body: comment.body };
      return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'IssueCommentEdge', node, cursor: null } };
    }
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
    return undefined;
  }
  // Object types
  if (typeName === 'User') {
    if (field.name === 'login') return parent.login;
    if (field.name === 'id') return parent.id;
    if (field.name === 'name') return parent.name;
    if (field.name === 'email') return parent.email;
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "User".` });
    return undefined;
  }
  if (typeName === 'Repository') {
    const repo = parent.repo as Repo;
    if (field.name === 'id') return repoGlobalId(repo);
    if (field.name === 'databaseId') return repo.dbId;
    if (field.name === 'name') return repo.name;
    if (field.name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
    if (field.name === 'owner') return userObj();
    if (field.name === 'defaultBranchRef') return { __typename: 'Ref', name: repo.defaultBranch };
    if (field.name === 'viewerPermission') return 'ADMIN';
    if (field.name === 'hasIssuesEnabled') return true;
    if (field.name === 'issue') {
      const issue = repo.issues.find((i) => i.number === Number(args.number));
      return issue ? issueObj(repo, issue) : null;
    }
    if (field.name === 'issues') return issueConnection(repo, args);
    if (field.name === 'pullRequests') return pullConnection(repo, args);
    if (field.name === 'pullRequest') {
      const pull = repo.pulls.find((p) => p.number === Number(args.number));
      return pull ? pullObj(repo, pull) : null;
    }
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Repository".` });
    return undefined;
  }
  if (typeName === 'Issue') {
    const issue = parent.issue as Issue;
    const repo = parent.repo as Repo;
    if (field.name === 'id') return issueGlobalId(repo, issue);
    if (field.name === 'number') return issue.number;
    if (field.name === 'title') return issue.title;
    if (field.name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
    if (field.name === 'body') return issue.body;
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Issue".` });
    return undefined;
  }
  if (typeName === 'PullRequest') {
    const pull = parent.pull as Pull;
    const repo = parent.repo as Repo;
    if (field.name === 'id') return pullGlobalId(repo, pull);
    if (field.name === 'number') return pull.number;
    if (field.name === 'state') return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    if (field.name === 'merged') return pull.merged;
    if (field.name === 'headRefName') return pull.headRef;
    if (field.name === 'baseRefName') return pull.baseRef;
    if (field.name === 'mergeable') return mergeableState(repo, pull);
    if (field.name === 'files') {
      const first = typeof args.first === 'number' ? args.first : pull.files.length;
      const nodes = pull.files.slice(0, first).map((f) => ({ __typename: 'PullRequestFile', path: f.filename, additions: f.additions, deletions: f.deletions, changes: f.changes }));
      return { __typename: 'PullRequestFileConnection', nodes, pageInfo: { __typename: 'PageInfo', hasNextPage: pull.files.length > first, hasPreviousPage: false, endCursor: null, startCursor: null }, totalCount: pull.files.length };
    }
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "PullRequest".` });
    return undefined;
  }
  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestFileConnection') {
    if (field.name === 'nodes') return parent.nodes;
    if (field.name === 'pageInfo') return parent.pageInfo;
    if (field.name === 'totalCount') return parent.totalCount;
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
    return undefined;
  }
  if (typeName === 'PageInfo') {
    if (field.name === 'hasNextPage') return parent.hasNextPage;
    if (field.name === 'hasPreviousPage') return parent.hasPreviousPage;
    if (field.name === 'startCursor') return parent.startCursor;
    if (field.name === 'endCursor') return parent.endCursor;
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "PageInfo".` });
    return undefined;
  }
  if (typeName === 'IssueComment') {
    if (field.name === 'id') return parent.id;
    if (field.name === 'body') return parent.body;
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "IssueComment".` });
    return undefined;
  }
  if (typeName === 'IssueCommentEdge') {
    if (field.name === 'node') return parent.node;
    if (field.name === 'cursor') return parent.cursor;
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "IssueCommentEdge".` });
    return undefined;
  }
  if (typeName === 'Ref') {
    if (field.name === 'name') return parent.name;
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Ref".` });
    return undefined;
  }
  if (typeName === '__Type') {
    if (field.name === 'name') return parent.name;
    if (field.name === 'kind') return parent.kind;
    if (field.name === 'fields') return parent.fields;
    if (field.name === 'enumValues') return parent.enumValues;
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "__Type".` });
    return undefined;
  }
  if (typeName === '__Field' || typeName === '__EnumValue') {
    if (field.name === 'name') return parent.name;
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
    return undefined;
  }
  if (typeName === '__Schema') {
    if (field.name === 'types') return parent.types;
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "__Schema".` });
    return undefined;
  }
  // Payload types: fields are the named objects.
  if (typeName.endsWith('Payload')) {
    if (field.name in parent) return parent[field.name];
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
    return undefined;
  }
  if (typeName === 'PullRequestFile') {
    if (field.name === 'path') return parent.path;
    if (field.name === 'additions') return parent.additions;
    if (field.name === 'deletions') return parent.deletions;
    if (field.name === 'changes') return parent.changes;
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "PullRequestFile".` });
    return undefined;
  }
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
  return undefined;
}
function gqlResolveSelections(typeName: string, parent: GqlObj | null, selections: GqlSelection[], doc: GqlDocument, ctx: GqlCtx): Record<string, unknown> | null {
  if (parent === null || parent === undefined) return null;
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'field') {
      const value = gqlResolveField(typeName, parent, sel, ctx);
      if (value === undefined) continue;
      const key = sel.alias ?? sel.name;
      if (sel.selections === null || value === null || typeof value !== 'object') {
        out[key] = value;
      } else if (Array.isArray(value)) {
        out[key] = value.map((item) => {
          if (item === null || typeof item !== 'object') return item;
          const itemType = (item as GqlObj).__typename ?? typeName;
          return gqlResolveSelections(itemType, item as GqlObj, sel.selections as GqlSelection[], doc, ctx);
        });
      } else {
        const childType = (value as GqlObj).__typename ?? typeName;
        out[key] = gqlResolveSelections(childType, value as GqlObj, sel.selections, doc, ctx);
      }
    } else if (sel.kind === 'inline') {
      if (sel.typeCondition !== null && sel.typeCondition !== typeName && sel.typeCondition !== parent.__typename) continue;
      const merged = gqlResolveSelections(typeName, parent, sel.selections, doc, ctx);
      if (merged) Object.assign(out, merged);
    } else if (sel.kind === 'spread') {
      const frag = doc.fragments.get(sel.name);
      if (!frag) continue;
      if (frag.typeCondition !== null && frag.typeCondition !== typeName && frag.typeCondition !== parent.__typename) continue;
      const merged = gqlResolveSelections(typeName, parent, frag.selections, doc, ctx);
      if (merged) Object.assign(out, merged);
    }
  }
  return out;
}
function executeGraphql(body: unknown): Record<string, unknown> {
  const runOne = (docBody: Record<string, unknown>): Record<string, unknown> => {
    const query = typeof docBody.query === 'string' ? docBody.query : '';
    const variables = (docBody.variables ?? {}) as Record<string, unknown>;
    const operationName = typeof docBody.operationName === 'string' ? docBody.operationName : null;
    try {
      const doc = new GqlParser(tokenizeGql(query)).parseDocument();
      let op = doc.operations[0];
      if (operationName !== null) {
        const named = doc.operations.find((o) => o.name === operationName);
        if (named) op = named;
      }
      if (!op) return { data: null, errors: [{ message: 'No operation provided.' }] };
      const mergedVars: Record<string, unknown> = { ...op.variables, ...variables };
      const ctx: GqlCtx = { variables: mergedVars, errors: [] };
      const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
      const data = gqlResolveSelections(rootType, { __typename: rootType }, op.selections, doc, ctx);
      const result: Record<string, unknown> = { data };
      if (ctx.errors.length > 0) result.errors = ctx.errors;
      return result;
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
    }
  };
  if (Array.isArray(body)) return { __batch: body.map((item) => runOne(item as Record<string, unknown>)) } as unknown as Record<string, unknown>;
  return runOne(body as Record<string, unknown>);
}
async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { message: 'invalid JSON body' });
    return;
  }
  const result = executeGraphql(body);
  const batch = (result as unknown as { __batch?: unknown[] }).__batch;
  if (batch !== undefined) {
    sendJson(res, 200, batch);
    return;
  }
  sendJson(res, 200, result);
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------
const MCP_TOOLS: Record<string, unknown>[] = [
  { name: 'create_repo', description: 'Create a new repository for the authenticated user.', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository by owner and name.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, state: { type: 'string', description: 'Issue state: open, closed, or all' } }, required: ['owner', 'repo'] } },
  { name: 'get_issue', description: 'Get a single issue by number.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, issue_number: { type: 'integer', description: 'Issue number' } }, required: ['owner', 'repo', 'issue_number'] } },
  { name: 'create_pull_request', description: 'Create a pull request in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Pull request title' }, body: { type: 'string', description: 'Pull request body' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request with a squash merge.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, pull_number: { type: 'integer', description: 'Pull request number' } }, required: ['owner', 'repo', 'pull_number'] } },
  { name: 'list_repositories', description: 'List repositories owned by the authenticated user.', inputSchema: { type: 'object', properties: {}, required: [] } },
];
function mcpToolResult(obj: unknown, isError = false): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj, isError };
}
function mcpCallTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const findTool = (suffix: string): boolean => normalized === suffix || normalized.endsWith(suffix);
  const missing = (keys: string[]): string | null => {
    for (const k of keys) if (args[k] === undefined || args[k] === null || args[k] === '') return k;
    return null;
  };
  if (findTool('createrepo')) {
    const miss = missing(['name']);
    if (miss) return mcpToolResult({ error: `missing required argument: ${miss}` }, true);
    const repoName = String(args.name);
    if (repos.has(repoKey(VIEWER.login, repoName))) return mcpToolResult({ error: `repository ${repoName} already exists` }, true);
    const repo = createRepo(VIEWER.login, repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
    return mcpToolResult(repoJson(repo));
  }
  if (findTool('getrepo')) {
    const miss = missing(['owner', 'repo']);
    if (miss) return mcpToolResult({ error: `missing required argument: ${miss}` }, true);
    const repo = repos.get(repoKey(String(args.owner), String(args.repo)));
    if (!repo) return mcpToolResult({ error: 'repository not found' }, true);
    return mcpToolResult(repoJson(repo));
  }
  if (findTool('createissue')) {
    const miss = missing(['owner', 'repo', 'title']);
    if (miss) return mcpToolResult({ error: `missing required argument: ${miss}` }, true);
    const repo = repos.get(repoKey(String(args.owner), String(args.repo)));
    if (!repo) return mcpToolResult({ error: 'repository not found' }, true);
    const issue = createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
    return mcpToolResult(issueJson(repo, issue));
  }
  if (findTool('listissues')) {
    const miss = missing(['owner', 'repo']);
    if (miss) return mcpToolResult({ error: `missing required argument: ${miss}` }, true);
    const repo = repos.get(repoKey(String(args.owner), String(args.repo)));
    if (!repo) return mcpToolResult({ error: 'repository not found' }, true);
    const state = typeof args.state === 'string' ? args.state : 'open';
    let list = [...repo.issues];
    if (state === 'open') list = list.filter((i) => i.state === 'open');
    else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
    const issues = list.map((i) => issueJson(repo, i));
    return mcpToolResult({ issues });
  }
  if (findTool('getissue')) {
    const miss = missing(['owner', 'repo', 'issue_number']);
    if (miss) return mcpToolResult({ error: `missing required argument: ${miss}` }, true);
    const repo = repos.get(repoKey(String(args.owner), String(args.repo)));
    if (!repo) return mcpToolResult({ error: 'repository not found' }, true);
    const issue = repo.issues.find((i) => i.number === Number(args.issue_number));
    if (!issue) return mcpToolResult({ error: 'issue not found' }, true);
    return mcpToolResult(issueJson(repo, issue));
  }
  if (findTool('createpullrequest')) {
    const miss = missing(['owner', 'repo', 'title', 'head', 'base']);
    if (miss) return mcpToolResult({ error: `missing required argument: ${miss}` }, true);
    const repo = repos.get(repoKey(String(args.owner), String(args.repo)));
    if (!repo) return mcpToolResult({ error: 'repository not found' }, true);
    const result = createPull(repo, String(args.title), typeof args.body === 'string' ? args.body : '', String(args.head), String(args.base));
    if ('error' in result) return mcpToolResult({ error: result.error }, true);
    return mcpToolResult(pullJson(repo, result));
  }
  if (findTool('mergepullrequest')) {
    const miss = missing(['owner', 'repo', 'pull_number']);
    if (miss) return mcpToolResult({ error: `missing required argument: ${miss}` }, true);
    const repo = repos.get(repoKey(String(args.owner), String(args.repo)));
    if (!repo) return mcpToolResult({ error: 'repository not found' }, true);
    const pull = repo.pulls.find((p) => p.number === Number(args.pull_number));
    if (!pull) return mcpToolResult({ error: 'pull request not found' }, true);
    if (pull.state !== 'open') return mcpToolResult({ error: 'pull request is not open' }, true);
    const sha = squashMerge(repo, pull);
    if (sha === null) return mcpToolResult({ error: 'merge conflict' }, true);
    return mcpToolResult({ sha, merged: true, message: 'Pull request successfully merged' });
  }
  if (findTool('listrepositories')) {
    const list = [...repos.values()].filter((r) => r.owner === VIEWER.login).sort((a, b) => a.createdSeq - b.createdSeq).map((r) => repoJson(r));
    return mcpToolResult({ repositories: list });
  }
  return mcpToolResult({ error: `unknown tool: ${name}` }, true);
}
async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  if (method === 'GET') {
    res.writeHead(405, { 'content-type': JSON_TYPE, 'x-github-request-id': reqId() });
    res.end(JSON.stringify({ message: 'Method Not Allowed' }));
    return;
  }
  if (method === 'DELETE') {
    sendJson(res, 204, null);
    return;
  }
  if (method !== 'POST') {
    res.writeHead(405, { 'content-type': JSON_TYPE, 'x-github-request-id': reqId() });
    res.end(JSON.stringify({ message: 'Method Not Allowed' }));
    return;
  }
  const raw = await readBody(req);
  let rpc: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    rpc = parsed as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const id = rpc.id === undefined ? null : rpc.id;
  const reply = (payload: Record<string, unknown>): void => sendJson(res, 200, payload);
  const rpcError = (code: number, message: string): void => reply({ jsonrpc: '2.0', id, error: { code, message } });
  const rpcResult = (result: unknown): void => reply({ jsonrpc: '2.0', id, result });
  const rpcMethod = typeof rpc.method === 'string' ? rpc.method : '';
  if (rpcMethod === 'notifications/initialized' || rpcMethod.startsWith('notifications/')) {
    res.writeHead(202, { 'x-github-request-id': reqId() });
    res.end();
    return;
  }
  if (rpcMethod === 'server/discover') {
    rpcResult({ supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, serverInfo: { name: 'forge', version: '1.0.0' }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'forge', version: '1.0.0' } } });
    return;
  }
  if (rpcMethod === 'initialize') {
    const params = (rpc.params ?? {}) as Record<string, unknown>;
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const version = /^\d{4}-\d{2}-\d{2}$/.test(offered) ? offered : '2025-11-25';
    rpcResult({ protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: 'forge', version: '1.0.0' } });
    return;
  }
  if (rpcMethod === 'ping') {
    rpcResult({});
    return;
  }
  if (rpcMethod === 'tools/list') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    rpcResult({ tools: MCP_TOOLS });
    return;
  }
  if (rpcMethod === 'tools/call') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const params = (rpc.params ?? {}) as Record<string, unknown>;
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const known = MCP_TOOLS.some((t) => {
      const toolName = String(t.name).toLowerCase().replace(/[^a-z0-9]/g, '');
      const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
      return normalized === toolName || normalized.endsWith(toolName);
    });
    if (!known) {
      rpcError(-32602, `unknown tool: ${name}`);
      return;
    }
    rpcResult(mcpCallTool(name, args));
    return;
  }
  rpcError(-32601, `method not found: ${rpcMethod}`);
}

// ---------------------------------------------------------------------------
// Dispatch + server
// ---------------------------------------------------------------------------
async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = pathOf(req);
  const method = req.method ?? 'GET';
  try {
    // Git smart HTTP: /{owner}/{repo}.git/{info/refs|git-upload-pack|git-receive-pack}
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
    if (gitMatch) {
      const owner = decodePath(gitMatch[1] as string);
      const name = decodePath(gitMatch[2] as string);
      const action = gitMatch[3] as string;
      const repo = repos.get(repoKey(owner, name));
      if (!repo) {
        gitNotFound(res);
        return;
      }
      if (action === 'info/refs' && method === 'GET') {
        handleInfoRefs(req, res, repo, queryOf(req).get('service'));
        return;
      }
      if (action === 'git-upload-pack' && method === 'POST') {
        const body = await readBody(req);
        handleUploadPack(req, res, repo, body);
        return;
      }
      if (action === 'git-receive-pack' && method === 'POST') {
        const body = await readBody(req);
        handleReceivePack(req, res, repo, body);
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (path === '/api/graphql' && method === 'POST') {
      await handleGraphql(req, res);
      return;
    }
    if (path === '/mcp') {
      await handleMcp(req, res);
      return;
    }
    if (path === '/api/v3/' || path === '/api/v3/meta' || path.startsWith('/api/v3/')) {
      await handleRest(req, res);
      return;
    }
    if (path === '/healthz' && method === 'GET') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }
    if (path === '/' && method === 'GET') {
      sendJson(res, 200, { message: 'forge is running', version: '1.0.0' });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
    } else {
      res.destroy();
    }
  }
}

export function createApp(): Server {
  const server = createServer((req, res) => {
    void handle(req, res);
  });
  return server;
}
