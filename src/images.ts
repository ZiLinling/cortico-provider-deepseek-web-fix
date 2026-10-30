/**
 * 图片上传。
 *
 * DeepSeek 网页版的识图不是「把图塞进请求」，而是：先把图上传成一个 file id，
 * 再在补全请求里用 `ref_file_ids` 引用它。上传本身也要过 PoW，和补全一样。
 *
 * 三步：
 *   1. POST /api/v0/file/upload_file（multipart，带 X-DS-PoW-Response 与 x-file-size）
 *   2. 轮询 GET /api/v0/file/fetch_files?file_ids=<id> 直到状态可引用
 *   3. 把 file id 交给补全的 ref_file_ids
 *
 * 设计取舍：
 *   - **按内容 hash 缓存**：同一张图在一轮对话里会被反复带上来（Cortico 每轮重放历史），
 *     不缓存就会反复上传，既慢又容易撞限流。缓存只驻内存，进程重启即失效。
 *   - **失败分级**：单张图解析失败只丢这张，不让整轮对话失败；全失败才抛。
 *   - **不猜字段**：上游的 id 字段历史上变过（`id` / `file_id` / `file.id`），三个都试。
 */
import { createHash } from 'node:crypto';
import { authHeaders, deviceIdFor, type WebAuth } from './auth.ts';
import { nodeHttp, type Http } from './http.ts';
import { powHeader, solvePow, type PowChallenge } from './pow.ts';

export const UPLOAD_PATH = '/api/v0/file/upload_file';
const FETCH_PATH = '/api/v0/file/fetch_files';
const CHALLENGE_PATH = '/api/v0/chat/create_pow_challenge';

/** 上游处理图片的状态词。就绪与失败各自一组，其余继续等。 */
const READY = /^(?:SUCCESS|PARSED|DONE|COMPLETED?|FINISHED|READY)$/;
const FAILED = /FAIL|ERROR|REJECT|UNSUPPORT|INVALID|EMPTY/;

/** DeepSeek 识图接受的格式；其它（如 SVG）不发送，只留文字占位。 */
const ACCEPTED = /^image\/(?:png|jpe?g|webp|gif)$/i;

const MAX_BYTES = 7 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1_000;
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX = 64;

export interface ImagePart {
  /** 内容 hash 的前 12 位，作缓存键。 */
  hash: string;
  mime: string;
  data: Buffer;
  filename: string;
}

export interface UploadDeps {
  baseUrl: string;
  auth: WebAuth;
  stateDir: string;
  signal?: AbortSignal;
  log?: { info(message: string): void; warn(message: string, details?: unknown): void };
  /** 发送方；走浏览器通道时是页面内的 fetch。 */
  http?: Http;
}

interface CacheEntry {
  fileId: string;
  at: number;
}

const cache = new Map<string, CacheEntry>();

function cacheGet(key: string): string | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.fileId;
}

function cacheSet(key: string, fileId: string): void {
  if (cache.size >= CACHE_MAX) {
    // 简单的先进先出：键是图片内容，没有「更常用」的区分意义。
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { fileId, at: Date.now() });
}

export function _resetImageCache(): void {
  cache.clear();
}

/**
 * 靠文件头判断图片格式。Cortico 传进来的句柄本身不带 MIME，
 * 一律当 png 会让 jpeg/webp/gif 被上游误判甚至拒绝。
 */
export function sniffMime(data: Buffer): string | null {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 6 && data.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF'
    && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

/** 从一个图片句柄解出可上传的图片；不支持的格式返回 null。 */
export function decodeImage(
  handle: string,
  mime: string | undefined,
  readBlob: (handle: string) => Buffer | null,
): ImagePart | null {
  const bytes = readBlob(handle);
  if (!bytes || bytes.length === 0 || bytes.length > MAX_BYTES) return null;
  const data = Buffer.from(bytes);
  // 声明的 MIME 优先，但要以文件头为准：句柄常常没有 MIME，或与内容不符。
  const sniffed = sniffMime(data);
  const declared = mime ? mime.split(';')[0]!.trim().toLowerCase() : '';
  const resolved = sniffed ?? (ACCEPTED.test(declared) ? declared : null);
  if (!resolved) return null;
  // 内容 hash 作缓存键：同一张图在重放历史时会反复出现，不该反复上传。
  const hash = createHash('sha256').update(data).digest('hex').substring(0, 12);
  const extension = (resolved.split('/')[1] ?? 'png').replace(/[^\w]/g, '').replace('jpeg', 'jpg');
  return { hash, mime: resolved, data, filename: `image-${hash}.${extension}` };
}

async function readJson(response: Response): Promise<{ ok: boolean; status: number; text: string; json: unknown }> {
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { ok: response.ok, status: response.status, text, json };
}

async function challengeHeader(base: string, auth: WebAuth, http: Http, signal?: AbortSignal): Promise<string> {
  const response = await http(`${base}${CHALLENGE_PATH}`, {
    method: 'POST',
    headers: { ...authHeaders(auth, deviceIdFor(auth)) },
    body: JSON.stringify({ target_path: UPLOAD_PATH }),
    redirect: 'error',
    signal: signal ?? AbortSignal.timeout(30_000),
  });
  const { json } = await readJson(response);
  const challenge = (json as { data?: { biz_data?: { challenge?: PowChallenge } } } | undefined)
    ?.data?.biz_data?.challenge;
  if (!challenge) throw new Error('取不到 PoW 挑战（登录可能已过期）');
  const answer = await solvePow(challenge, auth.wasmUrl);
  return powHeader(challenge, answer, UPLOAD_PATH);
}

function bizEnvelope(json: unknown): { bizCode?: number; message?: string } {
  const data = (json as { data?: Record<string, unknown> } | undefined)?.data;
  if (!data) return {};
  const bizCode = typeof data.biz_code === 'number' ? data.biz_code : undefined;
  const message = [data.biz_msg, data.biz_message, data.message, data.msg]
    .find(value => typeof value === 'string') as string | undefined;
  return { bizCode, message };
}

/** 从 fetch_files 的回应里读一张图的状态；上游返回过列表与 id 映射两种形状。 */
export function statusOf(json: unknown, fileId: string): { status: string; error: string | null } {
  const biz = (json as { data?: { biz_data?: unknown } } | undefined)?.data?.biz_data;
  const box = biz as { files?: unknown } | undefined;
  const list: Array<Record<string, unknown>> = Array.isArray(box?.files)
    ? (box!.files as Array<Record<string, unknown>>)
    : Array.isArray(biz) ? (biz as Array<Record<string, unknown>>)
    : biz && typeof biz === 'object' && (biz as Record<string, unknown>)[fileId]
      ? [(biz as Record<string, Record<string, unknown>>)[fileId]!]
      : biz && typeof biz === 'object' && ((biz as Record<string, unknown>).id || (biz as Record<string, unknown>).file_id)
        ? [biz as Record<string, unknown>]
        : [];
  const entry = list.find(file => file && (file.id === fileId || file.file_id === fileId))
    ?? (list.length === 1 ? list[0] : undefined);
  return {
    status: String(entry?.status ?? '').toUpperCase(),
    error: (entry?.error_msg ?? entry?.error ?? null) as string | null,
  };
}

/** 上传一张图并等到可引用，返回 file id。 */
export async function uploadImage(image: ImagePart, deps: UploadDeps): Promise<string> {
  const cached = cacheGet(image.hash);
  if (cached) return cached;

  const base = deps.baseUrl.replace(/\/+$/, '');
  const http = deps.http ?? nodeHttp;
  const powB64 = await challengeHeader(base, deps.auth, http, deps.signal);

  // fetch 自己会为 multipart 写 boundary；手写的 Content-Type 必须删掉，否则解析失败。
  const headers: Record<string, string> = { ...authHeaders(deps.auth, deviceIdFor(deps.auth)) };
  delete headers['Content-Type'];
  headers['X-DS-PoW-Response'] = powB64;
  headers['x-file-size'] = String(image.data.length);

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(image.data)], { type: image.mime }), image.filename);

  const uploadResponse = await http(`${base}${UPLOAD_PATH}`, {
    method: 'POST', headers, body: form, redirect: 'error',
    signal: deps.signal ?? AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  const upload = await readJson(uploadResponse);
  if (!upload.ok) throw new Error(`DeepSeek 图片上传失败：HTTP ${upload.status} ${upload.text.slice(0, 200)}`);
  const { bizCode, message } = bizEnvelope(upload.json);
  if (bizCode !== undefined && bizCode !== 0) {
    throw new Error(`DeepSeek 图片上传被拒（biz_code ${bizCode}）：${String(message ?? '').slice(0, 160)}`);
  }

  const biz = (upload.json as { data?: { biz_data?: Record<string, unknown> } } | undefined)?.data?.biz_data;
  const fileId = (biz?.id ?? biz?.file_id ?? (biz?.file as { id?: string } | undefined)?.id) as string | undefined;
  if (!fileId) throw new Error(`DeepSeek 上传回应里没有 file id：${upload.text.slice(0, 160)}`);

  // 处理是异步的：先看上传回应自带的状态，不够就轮询。
  let status = String(biz?.status ?? '').toUpperCase();
  const deadline = Date.now() + UPLOAD_TIMEOUT_MS;
  const pollHeaders: Record<string, string> = { ...authHeaders(deps.auth, deviceIdFor(deps.auth)) };
  delete pollHeaders['Content-Type'];
  while (!READY.test(status)) {
    if (FAILED.test(status)) throw new Error(`DeepSeek 无法处理这张图（status ${status}）`);
    if (Date.now() > deadline) throw new Error('DeepSeek 处理图片超时');
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    const polled = await http(`${base}${FETCH_PATH}?file_ids=${encodeURIComponent(fileId)}`, {
      method: 'GET', headers: pollHeaders, redirect: 'error',
      signal: deps.signal ?? AbortSignal.timeout(30_000),
    });
    const poll = await readJson(polled);
    if (!poll.ok) throw new Error(`查询图片状态失败：HTTP ${poll.status} ${poll.text.slice(0, 160)}`);
    const state = statusOf(poll.json, fileId);
    status = state.status;
    if (state.error && FAILED.test(status)) throw new Error(`DeepSeek 无法处理这张图：${state.error}`);
  }

  cacheSet(image.hash, fileId);
  return fileId;
}

/**
 * 批量上传。单张失败只丢这一张并记日志，不影响整轮；全部失败才抛错。
 * 返回可用的 file id 列表，顺序与输入一致（失败的已剔除）。
 */
export async function uploadImages(images: readonly ImagePart[], deps: UploadDeps): Promise<string[]> {
  if (images.length === 0) return [];
  const ids: string[] = [];
  const failures: string[] = [];
  for (const image of images) {
    try {
      ids.push(await uploadImage(image, deps));
    } catch (error) {
      const message = (error as Error).message;
      failures.push(message);
      deps.log?.warn(`DeepSeek 图片未能上传：${message}`, { hash: image.hash });
    }
  }
  if (ids.length === 0 && failures.length > 0) throw new Error(`DeepSeek 图片全部上传失败：${failures[0]}`);
  return ids;
}
