/**
 * 传输接缝。
 *
 * 所有对上游的 HTTP 调用都从这里走，目的是让「谁把请求发出去」变成可替换的：
 * 默认是 Node 的 `fetch`，打开浏览器通道后换成页面内的 `fetch`（TLS 指纹才是真浏览器）。
 *
 * 为什么需要这个接缝：`generate()` 内部直接调全局 `fetch`（框架
 * `providers/transport/response-http.ts:160`），没有注入点。所以流式补全那一处靠
 * 「把 URL 指向本地回环代理」，其余非流式调用（建会话 / 挑战 / 上传 / 轮询 / 探活）
 * 靠这个接缝。两处合起来，同一个账号不会出现两种客户端指纹。
 */
export type Http = (url: string, init: RequestInit) => Promise<Response>;

/** 默认实现：就是全局 fetch，行为与改造前完全一致。 */
export const nodeHttp: Http = (url, init) => fetch(url, init);

export interface TransportChannel {
  /**
   * 把 API 路径（如 `/api/v0/chat/completion`）解析成真正要 `fetch` 的地址。
   *
   * 走浏览器通道时返回本地回环代理的地址；否则返回 `baseUrl + path`。
   * 内部负责「按需启动浏览器」，所以是异步的。
   */
  urlFor(path: string): Promise<string>;
  /** 非流式调用。走浏览器通道时在页面里 `fetch` 并整段读回。 */
  readonly http: Http;
  /** 当前实际通道，写日志用（`node` / `browser`）。 */
  describe(): string;
}
