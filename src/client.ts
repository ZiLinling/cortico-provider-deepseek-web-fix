/**
 * DeepSeek Web 的传输。
 *
 * 复用了框架的 `generate()`：重试节奏、首包/空闲超时、中断、输出字符上限、计量与
 * 尝试记录全部由它负责。我们只提供三样东西——请求地址、请求头、以及把上游分片
 * 翻译成标准事件的 assembly。
 *
 * 三步握手（挑战 → 建会话 → 补全）塞在 `headers()` 里完成：`generate()` 先 await
 * headers()，再序列化 body，所以在 headers() 里补 body 是安全的。这一处不太直观，
 * 但换来的是不必重写一遍 generate() 的重试与超时。
 */
import type { Logger } from 'cortico/core/types.ts';
import type { Request, Response } from 'cortico/protocol/open-responses/index.ts';
import { BaseProvider } from 'cortico/providers/base.ts';
import { GenerationError, type GenerateOptions, type Generation } from 'cortico/core/generation.ts';
import { generate } from 'cortico/providers/transport/response-http.ts';
import type { ResponseAssembly } from 'cortico/providers/transport/response-assembly.ts';
import type { ResponseTransport } from 'cortico/providers/transport/response-http.ts';
import { LLMError } from 'cortico/providers/transport/errors.ts';
import { authHeaders, deviceIdFor, type WebAuth } from './auth.ts';
import { explain } from './errors.ts';
import type { AccountHealth } from './health.ts';
import { nodeHttp, type Http, type TransportChannel } from './http.ts';
import { decodeImage, uploadImages, type ImagePart } from './images.ts';
import { DeepSeekWebAssembly } from './assembly.ts';
import { MODEL_TYPE, realModelName, resolveModel, type WebModel } from './models.ts';
import { assistantBlock, boundPrompt, flatten, imagesOfContext, MAX_PROMPT_CHARS } from './prompt.ts';
import { toolReminder } from './tools.ts';
import { powHeader, solvePow, type PowChallenge } from './pow.ts';
import { SessionBridge } from './session.ts';

const COMPLETION_PATH = '/api/v0/chat/completion';
const CHALLENGE_PATH = '/api/v0/chat/create_pow_challenge';
const SESSION_PATH = '/api/v0/chat_session/create';
const DELETE_SESSION_PATH = '/api/v0/chat_session/delete';

export interface ClientOptions {
  baseUrl: string;
  auth: () => WebAuth | null;
  /** 端点目录，留着给图片缓存与调试落盘用。 */
  stateDir: string;
  log: Logger;
  keepThinking: () => boolean;
  /** 一次调用内第几次尝试；重试时不再信任上一条 chat。 */
  session: SessionBridge;
  readBlob?: (handle: string) => Buffer | null;
  /**
   * 放行的工具名。`null` = 全部放行（阶段一：先全开、实测哪些不能用）；
   * 数组 = 只放行这些；空数组 = 纯对话。
   */
  allowedTools: () => readonly string[] | null;
  /** 端点是否打开了「多模态」。关着时带图的请求直接报错，不静默丢图。 */
  multimodal: () => boolean;
  /** 图片句柄对应的 MIME；拿不到时返回 undefined，由上传层按内容判断。 */
  mimeOf: (handle: string) => string | undefined;
  /**
   * 请求闸门：串行 + 随机间隔 + 滚动窗口限速。不传就不限速（测试与脚本用）。
   * 见 `throttle.ts` 里的实测依据。
   */
  gate?: { run<T>(fn: () => Promise<T>): Promise<T> };
  /** 单次请求最多带多少份图片内容；超了只带最近的。0 = 不限制。 */
  maxRefImages?: () => number;
  /**
   * 传输通道。不传就是 Node 直连（改造前的行为）。
   * 传了之后：流式补全走它的回环代理，其余非流式调用走 `http`。
   */
  channel?: TransportChannel;
  /** 非流式调用的发送方；缺省是全局 `fetch`。 */
  http?: Http;
  /**
   * 账号健康状态。冷却期内 `prepare()` 直接拒绝，一个请求都不发——
   * 在处罚期继续撞，是最容易把「临时限制」升级成「封号」的做法。
   */
  health?: AccountHealth;
}

export class DeepSeekWebProvider extends BaseProvider {
  private readonly opts: ClientOptions;
  private attempt = 0;
  /** 缺省把可选回调补齐：少传一个就让整条链路崩掉，是契约太脆。 */
  private readonly tools = (): readonly string[] | null => this.opts.allowedTools?.() ?? null;
  private readonly imageOn = (): boolean => this.opts.multimodal?.() ?? false;
  private readonly mime = (handle: string): string | undefined => this.opts.mimeOf?.(handle);
  /** 所有非流式调用都从这里走，通道切换只需要换这一个函数。 */
  private readonly http: Http;
  /**
   * 每个会话本轮实际送上去了几张图。
   * 续接时只需要补「比上次多的那些」；重建时要把历史图全带上。
   */
  private readonly imagesDelivered = new Map<string, number>();

  constructor(opts: ClientOptions) {
    super();
    this.opts = opts;
    this.http = opts.http ?? nodeHttp;
  }

  async respond(request: Request, options: GenerateOptions = {}): Promise<Generation> {
    this.attempt = 0;
    const model = resolveModel(request.model);
    const flat = flatten(request, { allowedTools: this.tools() });
    const key = options.sessionId ?? options.role ?? 'default';

    if (flat.toolsInPrompt > 0 || flat.droppedTools > 0) {
      this.opts.log.info(
        `DeepSeek Web：工具说明书 ${flat.toolsInPrompt} 个`
        + (flat.droppedTools > 0 ? `，按名单跳过 ${flat.droppedTools} 个` : '（全开）'),
      );
    }

    if (flat.images.length > 0 && !this.imageOn()) {
      throw new GenerationError(
        `DeepSeek Web：收到 ${flat.images.length} 张图，但端点的「多模态」是关的。`
        + '请在端点页打开「多模态」，或先发纯文字。',
        [], null, { instance: 'deepseek-web-xml-fix', module: 'deepseek-web-xml-fix', model: request.model ?? '', compatibilityDomain: this.opts.baseUrl },
      );
    }

    // 上游永远回 SSE；即使调用方不要流式，也让 assembly 走一遍，好过写第二条解析路径。
    const emit = options.onEvent ?? (() => {});

    // 先把图片句柄解成可上传的字节；解不出的（SVG、超大图）跳过并记日志。
    const images: ImagePart[] = [];
    for (const handle of flat.images) {
      const decoded = decodeImage(handle, this.mime(handle), this.opts.readBlob ?? (() => null));
      if (decoded) images.push(decoded);
      else this.opts.log.warn(`DeepSeek Web：跳过一张无法读取或格式不支持的图片（${handle.slice(0, 40)}）`);
    }
    // 框架的 `responseRequest()` 只把文本放进 `request.input`；图片挂在 `options.context` 的
    // `blobs` 上。不取的话，AstrBot 的「传原图 + 正文 [图片]」会退化成只有 `[图片]` 三个字。
    const contextRecords = options.context ?? [];
    const contextImages = this.imageOn() ? imagesOfContext(contextRecords) : [];
    if (contextRecords.length) {
      this.opts.log.debug?.(
        `DeepSeek Web：上下文 ${contextRecords.length} 条｜图片 ${contextImages.length} 张`
        + `｜多模态 ${this.imageOn() ? '开' : '关'}`,
      );
    }
    for (const blob of contextImages) {
      const decoded = decodeImage(blob.handle, blob.mime, this.opts.readBlob ?? (() => null));
      if (!decoded) {
        this.opts.log.warn(`DeepSeek Web：跳过一张上下文图片（${blob.handle.slice(0, 48)}，${blob.mime}）`);
        continue;
      }
      // 同内容只传一次：同一张图可能在上下文里出现多轮。
      if (images.some(image => image.hash === decoded.hash)) continue;
      images.push(decoded);
    }
    const body: Record<string, unknown> = {
      chat_session_id: '',
      parent_message_id: null,
      model_type: MODEL_TYPE,
      prompt: '',
      ref_file_ids: [] as string[],
      thinking_enabled: model.thinking,
      search_enabled: model.search,
      action: null,
      preempt: false,
    };

    const origin = options.origin ?? {
      instance: 'deepseek-web-xml-fix', module: 'deepseek-web-xml-fix',
      model: request.model ?? '', compatibilityDomain: this.opts.baseUrl,
    };

    // 通道可能要先启动浏览器，所以地址必须在构造 transport 之前解析好。
    let url = `${this.opts.baseUrl.replace(/\/+$/, '')}${COMPLETION_PATH}`;
    if (this.opts.channel) {
      try {
        url = await this.opts.channel.urlFor(COMPLETION_PATH);
      } catch (error) {
        throw new GenerationError(
          (error as Error).message, [], null, origin,
          error instanceof LLMError ? error.status : 409, '', { cause: error },
        );
      }
    }

    const transport: ResponseTransport = {
      url,
      body,
      headers: async () => this.prepare(key, flat.full, flat.toolNames, model, body, options, images, flat.headChars),
      refresh: async () => this.reloadAuth(),
      assembly: (): ResponseAssembly => new DeepSeekWebAssembly(request, {
        onMessageIds: ids => this.opts.session.messageIds(key, ids.response),
        allowedTools: flat.toolNames,
        onToolNormalization: (name, form) => this.opts.log.info('工具调用已提取、校验并重封装', { tool: name, form }),
      }),
      parse: (): { response: Response; meters: never; serviceTier: null } => {
        throw new LLMError('DeepSeek Web 只产出 SSE，非流式路径不可达', 0, '');
      },
      failure: async () => false,
      succeeded: () => {},
      log: this.opts.log,
    };

    try {
      // 冷却期内直接返回：放在闸门外面，否则要白等 2~4 秒的请求间隔才报错。
      // `prepare()` 里还有一道（防重试路径绕过去），这里只是让反馈更快。
      const cooling = this.opts.health?.check();
      if (cooling && !cooling.allowed) {
        throw new GenerationError(
          cooling.message, [], null, origin, 429,
          JSON.stringify({ error: { code: 'account_cooldown', message: cooling.message, until: cooling.until } }),
        );
      }
      // 所有请求排一条队：同一账号同时只能生成一条，并发会触发账号级限流。
      const call = () => generate(request, { ...options, onEvent: emit }, origin, transport);
      const result = await (this.opts.gate ? this.opts.gate.run(call) : call());
      // 上游不报用量：把模型别名写进 metadata，事后能从流水里认出是哪次。
      const usageName = realModelName(model);
      (result.response as unknown as { metadata?: Record<string, unknown> }).metadata = {
        ...(result.response.metadata ?? {}), deepseek_web_model: usageName,
      };
      // 会话桥要知道「上游现在掌握到哪」：本轮送出的完整文本 + 这一轮的回复。
      // 块格式必须与 flatten() 一致，否则前缀对不上，每轮都会被判成重建。
      this.opts.session.delivered(key, flat.full + assistantBlock(replyText(result.response)));
      // 成功了就解除冷却：一次正常回答比任何计时器都能说明账号已恢复。
      this.opts.health?.succeed();
      return result;
    } catch (error) {
      if (!(error instanceof GenerationError)) throw error;
      const translated = this.explainFailure(error);
      // Core 只记 `status`，不记原因。不在这里写一条，用户只会看到「连续失败 5 次」。
      if (/已取消|aborted/i.test(error.message)) {
        this.opts.log.debug?.('DeepSeek Web：本轮被取消');
      } else {
        this.opts.log.warn(`DeepSeek Web 本轮失败（HTTP ${error.status}）：${translated ?? error.message}`);
      }
      if (!translated) throw error;
      throw new GenerationError(
        translated, error.attempts, error.partial, error.origin, error.status, error.body, { cause: error },
      );
    } finally {
      // 一轮结束：轮数 +1、解除占用。放在 finally 里，失败也要解除，否则这条 chat 会永久卡住。
      this.opts.session.turnDone(key);
    }
  }

  /**
   * 把上游失败翻成「发生了什么 + 下一步做什么」，并顺带记账。
   *
   * 记账只在这里做：代理只负责把 429 转成 409 并把 `Retry-After` 带上来，
   * 判定与冷却时长都集中在一处，免得两个地方各算一套。
   */
  private explainFailure(error: GenerationError): string | null {
    const proxy = parseProxyError(error.body);
    if (proxy?.code === 'account_cooldown') return proxy.message ?? null;
    // 凭证缺失是配置问题，不是账号问题：不进冷却，否则用户登录完还要白等十分钟。
    if (proxy?.code === 'auth_missing') return proxy.message ?? null;
    if (proxy?.code === 'upstream_unreachable') {
      return `DeepSeek Web：连不上上游（${proxy.message ?? '网络错误'}）。检查网络、代理或防火墙。`;
    }
    // 浏览器通道自己的故障（页面挂了、脚本注入失败）不是账号问题，也不该进冷却。
    const browser = browserTransportMessage(error.body);
    if (browser) return browser;
    if (!this.opts.health) return null;

    const status = proxy?.status ?? error.status;
    const observed = this.opts.health.observe(status, proxy?.retryAfterMs ?? null, error.body);
    // 认不出的错误保持原样，别用一句「上游返回 HTTP 500」盖掉真实信息。
    if (observed.diagnosis.kind === 'unknown') return null;
    return explain(observed.diagnosis, observed.until);
  }

  /** 401/403 后重新读一次凭证；token 变了才值得重试，否则只是浪费一次请求。 */
  private async reloadAuth(): Promise<boolean> {
    const before = this.opts.auth()?.token;
    const after = this.opts.auth();
    return Boolean(after && after.token !== before);
  }

  /**
   * 三步握手 + 请求头。这里顺手把 `body` 的 `chat_session_id` / `parent_message_id` /
   * `prompt` 补齐（由调用方持有的同一对象）。
   */
  private async prepare(
    key: string,
    fullPrompt: string,
    toolNames: readonly string[],
    model: WebModel,
    body: Record<string, unknown>,
    options: GenerateOptions,
    images: readonly ImagePart[],
    headChars: number,
  ): Promise<Record<string, string>> {
    const auth = this.opts.auth();
    if (!auth) {
      // 401 而不是 503：这是**永久性**失败，Core 对 5xx 会重试 5 次，等于把一条
      // 「凭证缺失」放大成十几条请求。4xx 才会让它立刻停下。
      this.opts.log.warn(
        `DeepSeek Web：读不到凭证。应放在 ${this.opts.stateDir}\\deepseek-auth.json（token / cookie / wasmUrl）`,
      );
      const message = `DeepSeek 网页会话未配置。把 deepseek-auth.json 放进端点目录（${this.opts.stateDir}）。`;
      throw new LLMError(message, 401, JSON.stringify({ error: { code: 'auth_missing', message } }));
    }

    // 冷却期内一个请求都不发。放在最前面，连 PoW 挑战也不去取。
    const verdict = this.opts.health?.check();
    if (verdict && !verdict.allowed) {
      throw new LLMError(verdict.message, 429, JSON.stringify({
        error: { code: 'account_cooldown', message: verdict.message, until: verdict.until },
      }));
    }

    const forceFresh = this.attempt > 0;
    this.attempt += 1;
    // 重建之前先记住旧会话 id：换新 chat 之后把旧的删掉，别在账号里堆垃圾会话。
    const previousChat = this.opts.session.inspect(key)?.chatSessionId;
    const plan = this.opts.session.plan(key, fullPrompt, forceFresh);
    this.opts.log.debug?.(`DeepSeek Web 会话：${plan.mode} — ${plan.reason}`);

    let chatSessionId = plan.chatSessionId;
    if (plan.mode === 'fresh' || !chatSessionId) {
      chatSessionId = await this.createSession(auth, options.signal);
      this.opts.session.open(key, chatSessionId, fullPrompt);
      // 删旧会话：不阻塞本轮，失败只记日志（删不掉不影响对话）。
      if (previousChat && previousChat !== chatSessionId) {
        void this.deleteSession(auth, previousChat);
      }
    }
    this.opts.session.markInflight(key, true);

    const headers = { ...authHeaders(auth, deviceIdFor(auth)), ...(await this.powHeaders(auth, options.signal)) };
    body.chat_session_id = chatSessionId;
    body.parent_message_id = plan.parentMessageId ?? null;
    // 每轮都补一句简短提醒（抄反代 `formatToolReminder`）：完整说明书只在会话开头，
    // 少了这句，DeepSeek 会逐渐偏离协议、改用普通文本说话。桌宠世界里那等于没回复。
    const reminder = toolReminder(toolNames);
    const withReminder = reminder ? `${plan.prompt}\n\n${reminder}` : plan.prompt;
    // 单次请求的字符预算：超了截中间。上游对超长 prompt 的反应是**返回空流**，
    // 不截的话表现就是「发了没反应」。截断只影响这一次请求，不重建会话。
    // 第三个参数告诉它「开头这段（工具说明书 + 系统提示）必须整段保住」。
    const prompt = boundPrompt(withReminder, MAX_PROMPT_CHARS, headChars);
    this.opts.log.debug?.(
      `DeepSeek Web 本轮：prompt ${prompt.length} 字，提醒${reminder ? '有' : '无'}，工具 ${toolNames.length} 个`,
    );
    if (prompt.length < withReminder.length) {
      this.opts.log.warn(`DeepSeek Web：本轮 prompt ${withReminder.length} 字超过预算 ${MAX_PROMPT_CHARS}，已截掉中间 ${withReminder.length - prompt.length} 字`);
    }
    body.prompt = prompt;
    body.thinking_enabled = model.thinking;
    body.search_enabled = model.search;

    // 图片：先上传换 file id，再让补全用 ref_file_ids 引用。
    // 续接时只补「比上次多的」；重建时要带全部历史图，否则模型看不到之前那张。
    if (images.length > 0) {
      const already = plan.mode === 'fresh' ? 0 : (this.imagesDelivered.get(key) ?? 0);
      const fresh = images.slice(already);
      try {
        const ids = await uploadImages(fresh, {
          baseUrl: this.opts.baseUrl,
          auth,
          stateDir: this.opts.stateDir,
          signal: options.signal,
          log: this.opts.log,
          http: this.http,
        });
        // 上游对一次请求的图片条目数有上限（实测 40~52）。超了**整轮被拒**，
        // 而且那条会话此后每轮都会失败——所以宁可按时间只带最近的 N 份。
        const cap = this.opts.maxRefImages?.() ?? 0;
        if (cap > 0 && ids.length > cap) {
          this.opts.log.warn(`DeepSeek Web：本轮图片 ${ids.length} 份超过上限 ${cap}，只带最近的 ${cap} 份`);
        }
        const refIds = cap > 0 ? ids.slice(-cap) : ids;
        body.ref_file_ids = refIds;
        this.imagesDelivered.set(key, images.length);
        // 两种通道都要记：Node 模式下上传不打别的日志，之前会误判成「图片没上传」。
        this.opts.log.debug?.(
          `DeepSeek Web：本轮带图 ${refIds.length} 份（本次新上传 ${fresh.length} 份）`,
        );
      } catch (error) {
        // 图挂了不连累对话：退回纯文字，并在日志里说清楚这一轮少了图。
        this.opts.log.warn(`DeepSeek Web：图片全部未上传，本轮以纯文字继续（${(error as Error).message}）`);
        body.ref_file_ids = [];
        this.imagesDelivered.set(key, 0);
      }
    } else {
      body.ref_file_ids = [];
      this.imagesDelivered.set(key, 0);
    }
    return headers;
  }

  private async createSession(auth: WebAuth, signal?: AbortSignal): Promise<string> {
    const response = await this.http(`${this.opts.baseUrl.replace(/\/+$/, '')}${SESSION_PATH}`, {
      method: 'POST',
      headers: { ...authHeaders(auth, deviceIdFor(auth)), 'Content-Type': 'application/json' },
      body: '{}',
      signal: signal ?? AbortSignal.timeout(30_000),
      redirect: 'error',
    });
    const text = await response.text();
    if (!response.ok) throw new LLMError(`DeepSeek 建会话失败：HTTP ${response.status}`, response.status, text.slice(0, 300));
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new LLMError('DeepSeek 建会话返回的不是 JSON（登录可能已过期）', 0, text.slice(0, 200));
    }
    const id = (json as { data?: { biz_data?: { id?: unknown; chat_session?: { id?: unknown } } } })
      ?.data?.biz_data;
    const value = (id?.chat_session?.id ?? id?.id);
    if (typeof value !== 'string' || !value) {
      throw new LLMError('DeepSeek 建会话的回应里没有 chat session id（登录可能已过期或要求验证码）', 0, text.slice(0, 200));
    }
    return value;
  }

  /**
   * 删掉一条不再用的网页端会话。
   *
   * 不阻塞当前请求：删不掉只是账号里多一条记录，不影响对话。失败只记 debug。
   */
  private async deleteSession(auth: WebAuth, chatSessionId: string): Promise<void> {
    try {
      const response = await this.http(`${this.opts.baseUrl.replace(/\/+$/, '')}${DELETE_SESSION_PATH}`, {
        method: 'POST',
        headers: { ...authHeaders(auth, deviceIdFor(auth)), 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_session_id: chatSessionId }),
        signal: AbortSignal.timeout(20_000),
        redirect: 'error',
      });
      if (!response.ok) {
        this.opts.log.debug?.(`DeepSeek Web：删除旧会话失败 HTTP ${response.status}`);
        return;
      }
      this.opts.log.debug?.('DeepSeek Web：已删除旧会话');
    } catch (error) {
      this.opts.log.debug?.(`DeepSeek Web：删除旧会话出错（已忽略）：${(error as Error).message}`);
    }
  }

  private async powHeaders(auth: WebAuth, signal?: AbortSignal): Promise<Record<string, string>> {
    const response = await this.http(`${this.opts.baseUrl.replace(/\/+$/, '')}${CHALLENGE_PATH}`, {
      method: 'POST',
      headers: { ...authHeaders(auth, deviceIdFor(auth)), 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_path: COMPLETION_PATH }),
      signal: signal ?? AbortSignal.timeout(30_000),
      redirect: 'error',
    });
    const text = await response.text();
    if (!response.ok) throw new LLMError(`DeepSeek 取 PoW 挑战失败：HTTP ${response.status}`, response.status, text.slice(0, 300));
    let challenge: PowChallenge | undefined;
    try {
      challenge = (JSON.parse(text) as { data?: { biz_data?: { challenge?: PowChallenge } } })?.data?.biz_data?.challenge;
    } catch {
      throw new LLMError('DeepSeek 的 PoW 回应不是 JSON', 0, text.slice(0, 200));
    }
    if (!challenge) {
      // 登录过期时上游回 200 但 biz_data 为 null，这一点很反直觉，所以文案要点明。
      throw new LLMError('DeepSeek 没有发出 PoW 挑战：登录可能已过期，或需要人机验证', 401, text.slice(0, 200));
    }
    const answer = await solvePow(challenge, auth.wasmUrl);
    return { 'X-DS-PoW-Response': powHeader(challenge, answer, COMPLETION_PATH) };
  }
}

/** 供 `index.ts` 与测试构造客户端。 */
export function createClient(opts: ClientOptions): DeepSeekWebProvider {
  return new DeepSeekWebProvider(opts);
}

/**
 * 回环代理用 409 + JSON 报「浏览器通道挂了」。把里面的原因翻成人话。
 *
 * 不翻译的话，`generate()` 会把错误统一包成 `LLM API 409`，用户看不到到底哪里出了问题。
 */
export function browserTransportMessage(body: string): string | null {
  if (!body || !body.includes('browser_transport')) return null;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    const message = parsed?.error?.message;
    if (message) {
      return `DeepSeek Web 浏览器通道出错：${message}。把端点里的「传输通道」改成 off 可以先恢复使用。`;
    }
  } catch {
    // 不是 JSON，走下面的通用文案。
  }
  return 'DeepSeek Web 浏览器通道出错。把端点里的「传输通道」改成 off 可以先恢复使用。';
}

/**
 * 代理用 409 + JSON 报错。把结构化信息取出来；上游自己的 JSON 错误没有这些字段，
 * 所以不会被误认。
 */
export interface ProxyErrorBody {
  code?: string;
  message?: string;
  /** 代理转发的上游原始状态码（比如被改写成 409 的 429）。 */
  status?: number;
  retryAfterMs?: number | null;
}

function parseProxyError(body: string): ProxyErrorBody | null {
  if (!body || !body.includes('"error"')) return null;
  try {
    const parsed = JSON.parse(body) as { error?: ProxyErrorBody };
    return parsed?.error ?? null;
  } catch {
    return null;
  }
}

/**
 * DeepSeek 网页端偶尔把内部安全分类混进正文，形如：
 *
 *   <ds_safety>[用户未成年]否 [分类]政治 [判定]…</ds_safety>Safe
 *
 * 那不是模型说的话。留着会进上下文污染会话，也可能被当成回复发出去，所以整段剥掉。
 */
export function stripSafetyBlocks(text: string): string {
  return text
    .replace(/<ds_safety>[\s\S]*?<\/ds_safety>\s*(?:Safe|Unsafe)?/gi, '')
    .trim();
}

/** 把一轮响应里的助手正文拼出来；只读 `message` 项，思考项不算。 */
export function replyText(response: Response): string {
  const output = (response.output ?? []) as Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  return stripSafetyBlocks(
    output
      .filter(item => item.type === 'message')
      .flatMap(item => item.content ?? [])
      .map(part => part.text ?? '')
      .join(''),
  );
}

export { COMPLETION_PATH, CHALLENGE_PATH, SESSION_PATH };
