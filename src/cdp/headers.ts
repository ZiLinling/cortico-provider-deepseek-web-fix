/**
 * 请求头清洗。
 *
 * 页面里的 `fetch()` 不允许手工设置一批「禁止的请求头名」（forbidden header name）：
 * 设了会被静默忽略，`Cookie` 甚至直接抛错。而我们现在的 `authHeaders()` 恰好带了
 * `Cookie` / `Origin` / `Referer` / `User-Agent` —— 这四个必须剥掉，让浏览器自己生成。
 *
 * 这不是妥协，是**收益**：浏览器生成的 `Origin` / `Referer` / `UA` / `sec-*` 一定是
 * 这台机器上真浏览器的值，比手填的字符串可靠得多（手填的 UA 骗得了服务端，骗不了 TLS）。
 */

/** Fetch 规范里的禁止请求头名，外加几个「浏览器会自动写」的。 */
const FORBIDDEN = new Set([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'connection',
  'content-length',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'referer',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
  // 规范之外，但浏览器会自动生成；手工设置要么无效要么多余。
  'user-agent',
  'priority',
  'upgrade-insecure-requests',
]);

const FORBIDDEN_PREFIXES = ['proxy-', 'sec-'];

export function isForbiddenHeader(name: string): boolean {
  const key = name.trim().toLowerCase();
  if (FORBIDDEN.has(key)) return true;
  return FORBIDDEN_PREFIXES.some(prefix => key.startsWith(prefix));
}

/**
 * 剥掉禁止头，其余原样保留。
 *
 * 注意 `content-type` **保留**：JSON 请求需要它；multipart 由调用方先删掉，
 * 让浏览器自己写 boundary。
 */
export function stripForbiddenHeaders(headers: Record<string, string | undefined> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value === undefined) continue;
    if (isForbiddenHeader(name)) continue;
    out[name] = value;
  }
  return out;
}

/** `HeadersInit` 在 Node 的类型里没有全局名，自己声明一份。 */
export type HeaderInput =
  | Headers
  | Array<string[] | [string, string]>
  | Record<string, string | readonly string[]>
  | undefined;

/** 把各种 header 输入统一成普通对象，方便清洗与序列化。 */
export function toHeaderRecord(init: HeaderInput): Record<string, string> {
  if (!init) return {};
  if (init instanceof Headers) {
    const out: Record<string, string> = {};
    init.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(init)) {
    const out: Record<string, string> = {};
    for (const entry of init) {
      const [key, value] = entry;
      if (typeof key === 'string' && typeof value === 'string') out[key] = value;
    }
    return out;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(init)) {
    if (typeof value === 'string') out[key] = value;
    else if (Array.isArray(value)) out[key] = value.join(', ');
  }
  return out;
}

/**
 * 逐跳头（hop-by-hop）：只对「本机 → 上游」这一段有意义，转发时必须去掉。
 *
 * 代理收到的请求里带着 `host: 127.0.0.1:<port>`、`connection: keep-alive`、
 * `content-length`（由下游算出来的值）。现在 undici 会自己覆盖 `host` / 丢掉 `connection`，
 * 但那是它的实现细节——不能把正确性押在这上面。
 */
const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'keep-alive',
  'content-length',
  'transfer-encoding',
  'expect',
  'upgrade',
  'te',
  'trailer',
]);

export function stripHopByHopHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

/** 从回传的响应头里挑出对下游有意义的部分；`content-encoding` 必须去掉（body 已被浏览器解压）。 */
export function cleanResponseHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const key = name.toLowerCase();
    if (key === 'content-encoding' || key === 'content-length' || key === 'transfer-encoding') continue;
    out[key] = value;
  }
  return out;
}
