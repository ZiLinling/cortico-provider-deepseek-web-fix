/**
 * DeepSeek Web 的 SSE 分片 → Cortico 的标准 Responses 事件。
 *
 * 上游不是 OpenAI 那套 `choices[].delta`，而是一串 JSON Patch：
 *
 *   {"v":{"response":{"message_id":2,"fragments":[],"status":"WIP"}}}
 *   {"p":"response/fragments","o":"APPEND","v":[{"type":"THINK","content":"…"}]}
 *   {"p":"response/fragments/-1/content","o":"APPEND","v":"lo"}
 *   {"v":" world"}                              ← 裸字符串，接在最后一个分片后面
 *   {"p":"response/status","o":"SET","v":"FINISHED"}
 *
 * 这里把它翻译成 `response.output_text.delta` / `response.reasoning.delta` 等标准事件，
 * 并在收尾时补齐 content_part.done / output_item.done / response.completed。
 *
 * 每个事件都过一遍 `ResponseAccumulator`：它是框架的协议校验器，宁可在这里抛错，
 * 也不要让一个形状不对的流进 Core。
 */
import type { OutputItem, Request, Response, StreamEvent } from 'cortico/protocol/open-responses/index.ts';
import { createResponse } from 'cortico/protocol/open-responses/index.ts';
import { ResponseAccumulator, ResponseProtocolError } from 'cortico/protocol/open-responses/stream.ts';
import * as transportErrors from 'cortico/providers/transport/errors.ts';

/**
 * 流内错误事件。框架 0.2.8 起只对 `StreamErrorEvent` **不重试**；0.2.7 没有这个导出。
 *
 * 运行时探测而不是直接 import：老宿主上直接 import 一个不存在的导出会让整个扩展加载失败，
 * 那比「多重试两次」严重得多。
 */
const StreamErrorEvent = (transportErrors as {
  StreamErrorEvent?: new (body: string) => Error;
}).StreamErrorEvent;
import { unknownMeters, type TokenMeters } from 'cortico/core/generation.ts';
import { isToolCallCandidate, looksLikeToolCall, parseToolCall, type ParsedCall, type ToolLike } from './tools.ts';
import { ToolCallValidator, ToolOutputError } from './tool-validation.ts';

interface MutableOutput {
  id: string;
  type: string;
  status?: string;
  role?: string;
  content?: Array<{ type: string; text?: string; annotations?: unknown[] }>;
  summary?: unknown[];
  call_id?: string;
  name?: string;
  arguments?: string;
}

interface NativeFragment {
  type?: string;
  content?: string;
  status?: string;
}

interface Patch {
  v?: unknown;
  p?: string;
  o?: string;
  type?: string;
  content?: string;
}

/** 上游分片归类：思考 vs 正文。 */
function fragmentKind(fragment: NativeFragment): 'reasoning' | 'text' | 'ignored' {
  const type = String(fragment.type ?? '').toUpperCase();
  if (type === 'THINK' || type === 'REASONING') return 'reasoning';
  if (type === 'RESPONSE' || type === 'SEARCH') return 'text';
  return 'ignored';
}

export interface AssemblyHooks {
  /** 上游分配的消息 id：`response_message_id` 是下一轮的 `parent_message_id`。 */
  onMessageIds?(ids: { request?: number; response?: number }): void;
  allowedTools?: readonly string[];
  onToolNormalization?(name: string, form: string): void;
}

export class DeepSeekWebAssembly {
  private readonly response: Response;
  private readonly accumulator = new ResponseAccumulator();
  private readonly hooks: AssemblyHooks;
  private readonly toolValidator: ToolCallValidator;
  private sequence = 0;
  private started = false;
  private status: string = 'WIP';
  private finished = false;
  private readonly output: MutableOutput[] = [];
  private reasoningIndex: number | null = null;
  private messageIndex: number | null = null;
  private readonly fragments: NativeFragment[] = [];
  /**
   * 正文的两种处理方式：
   *   - `stream`：已经确认是普通文本，边收边发；
   *   - `buffer`：开头像工具调用，先攒着，收尾时再判定是调用还是文本。
   * 判定点在第一段非空正文的第一个字符 —— 调用通常整段就是一个 JSON。
   */
  private textMode: 'undecided' | 'stream' | 'buffer' = 'undecided';
  private readonly pending: string[] = [];

  constructor(request: Request, hooks: AssemblyHooks = {}) {
    this.response = createResponse(`resp_${crypto.randomUUID()}`, request);
    this.response.model = request.model ?? this.response.model;
    this.hooks = hooks;
    this.toolValidator = new ToolCallValidator((request.tools ?? []) as ToolLike[], hooks.allowedTools);
  }

  private send(event: Record<string, unknown>, emit: (event: StreamEvent) => void): void {
    const complete = structuredClone({ ...event, sequence_number: this.sequence++ }) as StreamEvent;
    this.accumulator.accept(complete);
    emit(complete);
  }

  private start(emit: (event: StreamEvent) => void): void {
    if (this.started) return;
    this.send({ type: 'response.created', response: this.response }, emit);
    this.started = true;
  }

  /** 按需创建输出项；思考项在前、正文项在后，索引顺序与上游一致。 */
  private slot(kind: 'reasoning' | 'text', emit: (event: StreamEvent) => void): number {
    const existing = kind === 'reasoning' ? this.reasoningIndex : this.messageIndex;
    if (existing !== null) return existing;
    const index = this.output.length;
    const item: MutableOutput = kind === 'reasoning'
      ? { type: 'reasoning', id: `rs_${crypto.randomUUID()}`, summary: [], content: [] }
      : { type: 'message', id: `msg_${crypto.randomUUID()}`, role: 'assistant', status: 'in_progress', content: [] };
    this.output.push(item);
    this.send({ type: 'response.output_item.added', output_index: index, item }, emit);
    const part = kind === 'reasoning'
      ? { type: 'reasoning_text', text: '', annotations: [] }
      : { type: 'output_text', text: '', annotations: [] };
    this.send({ type: 'response.content_part.added', output_index: index, item_id: item.id, content_index: 0, part }, emit);
    item.content = [part];
    if (kind === 'reasoning') this.reasoningIndex = index;
    else this.messageIndex = index;
    return index;
  }

  private append(kind: 'reasoning' | 'text', delta: string, emit: (event: StreamEvent) => void): void {
    if (!delta) return;
    if (kind === 'text') {
      this.emitText(delta, emit);
      return;
    }
    // response.created 必须先于任何内容事件，否则协议校验器会拒收整条流。
    this.start(emit);
    const index = this.slot('reasoning', emit);
    const item = this.output[index]!;
    this.send({ type: 'response.reasoning.delta', output_index: index, item_id: item.id, content_index: 0, delta }, emit);
    const part = item.content![0]!;
    part.text = (part.text ?? '') + delta;
  }

  /**
   * 正文先走这里：决定是立刻发增量，还是先攒着等收尾判定。
   * 返回 true 表示已经处理完，不再进普通文本路径。
   */
  private emitText(delta: string, emit: (event: StreamEvent) => void): boolean {
    if (this.textMode === 'stream') {
      this.sendText(delta, emit);
      return true;
    }
    this.pending.push(delta);
    // 有工具时先收齐本轮正文，避免代码块或分片边界让调用提前落成普通 message。
    if (this.toolValidator.hasTools) {
      this.textMode = 'buffer';
      return true;
    }
    if (this.textMode === 'undecided') {
      const sofar = this.pending.join('');
      // 上游会先发若干纯空白帧；这时候还不能判定，也不能启动响应。
      if (!sofar.trim()) return true;
      // 第一个非空字符就能定：像调用就攒着，否则立刻开流并把已攒的吐出去。
      this.textMode = looksLikeToolCall(sofar) ? 'buffer' : 'stream';
      if (this.textMode === 'stream') {
        this.start(emit);
        this.pending.length = 0;
        this.sendText(sofar, emit);
      }
      return true;
    }
    return true;
  }

  private sendText(delta: string, emit: (event: StreamEvent) => void): void {
    this.start(emit);
    const index = this.slot('text', emit);
    const item = this.output[index]!;
    this.send({ type: 'response.output_text.delta', output_index: index, item_id: item.id, content_index: 0, delta, logprobs: [] }, emit);
    const part = item.content![0]!;
    part.text = (part.text ?? '') + delta;
  }

  /** 收尾时把攒着的正文落地：是调用就发 function_call，不是就当普通文本发出去。 */
  private flushPending(emit: (event: StreamEvent) => void): ParsedCall | null {
    const buffered = this.pending.join('');
    this.pending.length = 0;
    if (!buffered.trim()) return null;
    const call = parseToolCall(buffered);
    if (call) {
      if (this.status === 'INCOMPLETE') throw new ToolOutputError('incomplete_generation', '上游标记本轮生成未完成');
      this.toolValidator.validate(call);
      this.hooks.onToolNormalization?.(call.name, call.form);
      return call;
    }
    if (isToolCallCandidate(buffered)) {
      throw new ToolOutputError('unparsed_tool_call', '检测到工具调用标记，但无法提取唯一工具名和完整 JSON 参数');
    }
    // 普通正文仍按正文交付；疑似但无效的工具调用已明确报错。
    this.sendText(buffered, emit);
    return null;
  }

  /** 把一个工具调用发成标准事件流。 */
  private emitCall(call: ParsedCall, emit: (event: StreamEvent) => void): void {
    this.start(emit);
    const index = this.output.length;
    const item: MutableOutput = {
      type: 'function_call',
      id: `fc_${crypto.randomUUID()}`,
      call_id: `call_${crypto.randomUUID()}`,
      name: call.name,
      arguments: '',
      status: 'in_progress',
    };
    this.output.push(item);
    this.send({ type: 'response.output_item.added', output_index: index, item }, emit);
    this.send({ type: 'response.function_call_arguments.delta', output_index: index, item_id: item.id, delta: call.argumentsJson }, emit);
    item.arguments = call.argumentsJson;
    this.send({ type: 'response.function_call_arguments.done', output_index: index, item_id: item.id, arguments: call.argumentsJson }, emit);
    item.status = 'completed';
    this.send({ type: 'response.output_item.done', output_index: index, item }, emit);
  }

  /** 上游把一个完整分片的正文交给这里：只在首次出现时整段吐出。 */
  private takeFragment(fragment: NativeFragment, emit: (event: StreamEvent) => void): void {
    this.fragments.push(fragment);
    const kind = fragmentKind(fragment);
    if (kind === 'ignored') return;
    this.append(kind, String(fragment.content ?? ''), emit);
  }

  /** `p=response/fragments/-1/content` 或裸字符串：接在最后一个分片后面。 */
  private appendToLast(text: string, emit: (event: StreamEvent) => void): void {
    const last = this.fragments[this.fragments.length - 1];
    if (!last) {
      // 上游在首个分片之前偶尔会送一段裸文本；当作正文处理，不丢内容。
      this.append('text', text, emit);
      return;
    }
    last.content = String(last.content ?? '') + text;
    const kind = fragmentKind(last);
    if (kind !== 'ignored') this.append(kind, text, emit);
  }

  feed(payload: unknown, emit: (event: StreamEvent) => void): void {
    if (!payload || typeof payload !== 'object') return;
    if (process.env.DEEPSEEK_WEB_DEBUG === '1') {
      // 诊断开关：只在排查上游帧格式时开，平时不打印（凭证不在帧里，但仍保持安静）。
      console.log('[ds-frame]', JSON.stringify(payload).slice(0, 600));
    }
    const patch = payload as Patch;

    if (patch.type === 'error') {
      const content = String(patch.content ?? '').trim();
      const detail = JSON.stringify({ message: content || 'DeepSeek 上游在流中报错' });
      // 0.2.8+：框架据此**不重试**，并且 status 0 + body 让上下文超限还能被认成 handoff。
      if (StreamErrorEvent) throw new StreamErrorEvent(detail);
      // 0.2.7 及更早：没有这个类，只能退回原来的行为（会被重试）。
      throw new ResponseProtocolError(`DeepSeek 上游报错：${content}`);
    }

    // 上游第一帧常常是裸的 id 对：{"request_message_id":1,"response_message_id":2}
    // 它不在 `v.response` 里面，容易漏掉；漏了就会让下一轮的 parent_message_id 变成 null，
    // 表现为「Bot 看不到上一轮说了什么」。
    const raw = payload as { request_message_id?: unknown; response_message_id?: unknown };
    if (typeof raw.response_message_id === 'number' || typeof raw.request_message_id === 'number') {
      this.hooks.onMessageIds?.({
        request: typeof raw.request_message_id === 'number' ? raw.request_message_id : undefined,
        response: typeof raw.response_message_id === 'number' ? raw.response_message_id : undefined,
      });
    }

    // 初始快照：{"v":{"response":{...}}}
    if (patch.v && typeof patch.v === 'object' && !Array.isArray(patch.v)) {
      const snapshot = (patch.v as { response?: Record<string, unknown> }).response;
      if (snapshot) {
        const requestId = typeof snapshot.request_message_id === 'number' ? snapshot.request_message_id : undefined;
        // 快照里的 `message_id` 就是这一轮的助手消息 id。
        const responseId = typeof snapshot.response_message_id === 'number' ? snapshot.response_message_id
          : typeof snapshot.message_id === 'number' ? snapshot.message_id
          : undefined;
        if (requestId !== undefined || responseId !== undefined) this.hooks.onMessageIds?.({ request: requestId, response: responseId });
        if (typeof snapshot.status === 'string') this.status = snapshot.status;
        const fragments = snapshot.fragments;
        if (Array.isArray(fragments)) for (const fragment of fragments) this.takeFragment(fragment as NativeFragment, emit);
        return;
      }
    }

    const path = String(patch.p ?? '');

    // 批量补丁：{"p":"response","o":"BATCH","v":[<子补丁>…]}
    // 短回答时上游常把分片、状态、用量一次性塞进一个 BATCH，不递归就等于什么都没看到。
    if (path === 'response' && Array.isArray(patch.v)) {
      for (const child of patch.v) this.feed(child, emit);
      return;
    }

    // 分片数组追加：{"p":"response/fragments","o":"APPEND","v":[{...}]}
    if ((path === 'response/fragments' || path === 'fragments') && Array.isArray(patch.v)) {
      for (const fragment of patch.v) this.takeFragment(fragment as NativeFragment, emit);
      return;
    }

    // 指定分片的正文追加：{"p":"response/fragments/-1/content","o":"APPEND","v":"lo"}
    if (path.startsWith('response/fragments/') && path.endsWith('/content') && typeof patch.v === 'string') {
      this.appendToLast(patch.v, emit);
      return;
    }

    // 状态：{"p":"response/status","o":"SET","v":"FINISHED"}
    if (path === 'response/status' && typeof patch.v === 'string') {
      this.status = patch.v;
      return;
    }

    // 不带 path 的控制帧：{"p":"quasi_status","v":"FINISHED"}、{"p":"accumulated_token_usage","v":211}
    // 上游会把它们同时放在 BATCH 里和 BATCH 外面各发一次。不识别就会被当成裸字符串，
    // 追加到正文末尾 —— 表现为回答后面莫名其妙多出一个 "FINISHED"。
    if (path === 'quasi_status') {
      if (typeof patch.v === 'string') this.status = patch.v;
      return;
    }
    if (path === 'accumulated_token_usage') {
      // 网页版只报一个累计数，拆不出输入/输出，所以只认下不采用。
      return;
    }
    if (path) return;

    // 裸字符串：{"v":" world"}
    if (typeof patch.v === 'string') {
      this.appendToLast(patch.v, emit);
    }
  }

  /** 上游说 INCOMPLETE（撞到输出上限）时，`reason` 应当是 `max_output_tokens`。 */
  finish(emit: (event: StreamEvent) => void): Response {
    if (this.finished) throw new ResponseProtocolError('DeepSeek 流已结束，不能再次收尾');
    // 先把攒着的正文落地：可能是工具调用，也可能是普通文本。
    // 这一步必须在 `started` 判定之前 —— 正文在缓冲里时 `started` 还是 false，
    // 先判就会把一整条工具调用误判成「流是空的」。
    const call = this.flushPending(emit);
    if (call) this.emitCall(call, emit);
    if (!this.started) throw new ResponseProtocolError('DeepSeek 流在收到任何内容前结束');
    this.finished = true;
    const incomplete = this.status === 'INCOMPLETE';

    for (let index = 0; index < this.output.length; index++) {
      const item = this.output[index]!;
      if (item.type === 'function_call') continue;
      const part = item.content?.[0];
      if (part) {
        this.send({ type: 'response.content_part.done', output_index: index, item_id: item.id, content_index: 0, part }, emit);
      }
      if (item.type !== 'reasoning') item.status = incomplete && index === this.output.length - 1 ? 'incomplete' : 'completed';
      this.send({ type: 'response.output_item.done', output_index: index, item }, emit);
    }
    this.response.output = this.output as unknown as OutputItem[];
    this.response.usage = null;
    this.response.status = incomplete ? 'incomplete' : 'completed';
    this.response.completed_at = Math.floor(Date.now() / 1000);
    this.response.incomplete_details = incomplete ? { reason: 'max_output_tokens' } : null;
    this.send({ type: `response.${this.response.status}`, response: this.response }, emit);
    return this.accumulator.finish();
  }

  snapshot(): Response | null {
    return this.accumulator.snapshot();
  }

  /** 网页接口不报用量，官方也没有价目；金额留空，只记调用次数。 */
  meters(): TokenMeters {
    return unknownMeters();
  }

  serviceTier(): string | null {
    return null;
  }
}

export { fragmentKind };
