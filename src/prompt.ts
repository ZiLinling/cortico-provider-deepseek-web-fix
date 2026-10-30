/**
 * Cortico 的规范请求 → DeepSeek Web 的单个 `prompt` 字符串。
 *
 * 上游只收一段文本（外加 `ref_file_ids`），没有角色数组。所以这里把 instructions 与
 * 历史轮次压成有标记的纯文本。压法是**确定性**的：同样的输入永远得到同样的字节，
 * 会话桥靠这个前缀比对来判断「是不是同一条 chat 的续写」。
 *
 * 工具由 tools.ts 生成说明书并解析模型输出；网页版工具调用通过提示词模拟。
 */
import type { Request } from 'cortico/protocol/open-responses/index.ts';
import type { ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { buildToolManual, manualToolNames, toolReminder, TOOL_RULE, type ToolLike } from './tools.ts';

/**
 * 从上下文里取图片附件。
 *
 * 框架的 `responseRequest()` 只把**文本**放进 `request.input`；图片挂在
 * `context[].context.blobs` 上（内置的 Responses 兼容 provider 会自己转换，自定义 provider
 * 必须自己取）。不取的话图片会静默退化成 `[图片]` 文本——表现就是「模型看不见图」。
 */
export function imagesOfContext(
  context: readonly ContextRecord[] | undefined,
): Array<{ handle: string; mime: string }> {
  const seen = new Set<string>();
  const out: Array<{ handle: string; mime: string }> = [];
  for (const record of context ?? []) {
    for (const blob of record.context?.blobs ?? []) {
      if (!blob?.handle || typeof blob.mime !== 'string' || !blob.mime.startsWith('image/')) continue;
      if (seen.has(blob.handle)) continue;
      seen.add(blob.handle);
      out.push({ handle: blob.handle, mime: blob.mime });
    }
  }
  return out;
}

export interface FlattenOptions {
  /**
   * 放行的工具名。`null` = 全部放行（阶段一：先全开、实测哪些不能用）；
   * `[]` = 一个都不放行（纯对话）。
   */
  allowedTools?: readonly string[] | null;
}

/**
 * 单次请求的 prompt 字符预算。
 *
 * 上游对「一次塞多少文本」有上限：超了不报错，直接返回空流，表现为「发了没反应」。
 * 反代实测把阈值定在 80,000 字符。实测 96k 也能过，但**首字要 16 秒**——预填充是实打实的
 * 延迟。所以默认取 80,000：安全、够快；靠「先保住系统前缀」的截断保证人格与工具说明不被切。
 *
 * 部署方确认上游吃得下更多（或更少）时，用环境变量 `DEEPSEEK_WEB_MAX_PROMPT_CHARS`
 * 覆盖，单位是字符。低于 20000 的值按默认处理，避免误设成 0 让整套对话失效。
 */
export const MAX_PROMPT_CHARS = (() => {
  const raw = Number(process.env.DEEPSEEK_WEB_MAX_PROMPT_CHARS);
  return Number.isFinite(raw) && raw >= 20_000 ? raw : 80_000;
})();

/** 截断处的标记，让模型知道中间有内容被拿掉了。 */
const COMPACTION_MARKER = '\n\n[Earlier context compacted by cortico-provider-deepseek-web]\n\n';

/** 历史里每条助手回复保留多少字；抄反代 `MAX_HISTORY_ENTRY_CHARS = 2000`。 */
const MAX_HISTORY_MESSAGE_CHARS = 2000;

/** 保留开头，截掉尾部，并写明砍了多少。 */
function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…[截断 ${text.length - maxChars} 字]`;
}

/**
 * 超预算时保留头尾、截掉中间。
 *
 * 为什么截中间而不是截尾：开头是系统提示词与工具说明书，结尾是刚发生的事，
 * 两头都是模型必须看的；中间是最老的历史。
 *
 * `headChars` 是调用方告诉我们的「开头必须保住多少字」（工具说明书 + 系统提示）。
 * 早先按固定 35% 切头，人格前缀一长就会被切掉半截——那是比慢更糟的事故。
 */
export function boundPrompt(text: string, maxChars = MAX_PROMPT_CHARS, headChars = -1): string {
  const value = String(text ?? '');
  if (value.length <= maxChars) return value;
  if (maxChars <= 0) return '';
  if (maxChars <= COMPACTION_MARKER.length) return value.slice(value.length - maxChars);
  const budget = maxChars - COMPACTION_MARKER.length;
  // 没被告知时沿用旧的 35%；被告知时以它为准。
  const wanted = headChars >= 0 ? headChars : Math.floor(budget * 0.35);
  // 至少给「最近发生的事」留 8000 字：否则前缀把预算吃光，模型会丢掉刚聊过的内容。
  const minTail = Math.min(8_000, Math.floor(budget * 0.25));
  const keep = Math.max(0, Math.min(wanted, budget - minTail));
  const tail = budget - keep;
  return value.slice(0, keep) + COMPACTION_MARKER + value.slice(value.length - tail);
}

export interface Flattened {
  /** 完整文本，用于重建 chat。 */
  full: string;
  /** 开头「工具说明书 + 系统提示」占多少字；截断时优先保住这一段。 */
  headChars: number;
  /** 请求里出现的图片句柄，交给图片层上传后填进 `ref_file_ids`。 */
  images: string[];
  /** 写进 prompt 的工具数量。 */
  toolsInPrompt: number;
  /** 写进 prompt 的工具名，用来生成每轮的简短提醒。 */
  toolNames: string[];
  /** 请求里有、但没写进 prompt 的工具数量。 */
  droppedTools: number;
}

type Part = { type?: string; text?: string; image_url?: unknown; file_id?: unknown; url?: unknown };
type Item = Record<string, unknown>;

const ROLE_LABEL: Record<string, string> = {
  user: '用户',
  assistant: '助手',
  developer: '系统',
  system: '系统',
};

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    // `function_call_output.output` 允许是对象或单个分片，不能直接丢。
    if (content && typeof content === 'object') {
      const node = content as Part & { content?: unknown };
      if (typeof node.text === 'string') return node.text;
      if (node.content !== undefined) return textOf(node.content);
    }
    return '';
  }
  const pieces: string[] = [];
  for (const raw of content) {
    const part = raw as Part;
    if (typeof part?.text === 'string') pieces.push(part.text);
  }
  return pieces.join('');
}

/** `image_url` 在协议里是 `string | { url } | null`，两种形式都要认。 */
function imageHandleOf(part: Part): string | null {
  if (typeof part.file_id === 'string' && part.file_id) return part.file_id;
  const raw = part.image_url ?? part.url;
  if (typeof raw === 'string' && raw) return raw;
  if (raw && typeof raw === 'object') {
    const url = (raw as { url?: unknown }).url;
    if (typeof url === 'string' && url) return url;
  }
  return null;
}

function imagesOf(content: unknown, into: string[]): void {
  if (!Array.isArray(content)) return;
  for (const raw of content) {
    const part = raw as Part;
    if (part?.type !== 'input_image' && part?.type !== 'image') continue;
    const handle = imageHandleOf(part);
    if (handle) into.push(handle);
  }
}

/** instructions 可能是字符串，也可能是内容分片数组。 */
function instructionsOf(request: Request): string {
  const value = (request as unknown as { instructions?: unknown }).instructions;
  return textOf(value).trim();
}

export function flatten(request: Request, options: FlattenOptions = {}): Flattened {
  const images: string[] = [];
  // 历史（可能被截断的部分）
  const blocks: string[] = [];
  // 工具说明书 + 系统提示：截断时必须整段保住，否则人格会被切掉半截。
  const head: string[] = [];

  const instructions = instructionsOf(request);
  if (instructions) head.push(`[系统]\n${instructions}`);

  const input = request.input;
  if (typeof input === 'string') {
    blocks.push(`[用户]\n${input}`);
  } else if (Array.isArray(input)) {
    for (const raw of input) {
      const item = raw as Item;
      const type = String(item.type ?? '');

      if (type === 'message' || item.role !== undefined) {
        const role = String(item.role ?? 'user');
        imagesOf(item.content, images);
        const text = textOf(item.content).trim();
        if (!text && item.content && Array.isArray(item.content)
          && (item.content as Part[]).some(part => part?.type === 'input_image' || part?.type === 'image')) {
          // 只有图片的一轮：留一个标记，别让整条消息变成空行。
          blocks.push(`[${ROLE_LABEL[role] ?? role}]\n（附图）`);
        } else if (text) {
          blocks.push(`[${ROLE_LABEL[role] ?? role}]\n${role === 'assistant' ? clip(text, MAX_HISTORY_MESSAGE_CHARS) : text}`);
        }
        continue;
      }

      if (type === 'function_call') {
        // 历史里可能残留别的 provider 产生的调用；保留为文本，避免上下文断层。
        blocks.push(`[助手·工具调用 ${String(item.name ?? '')}]\n${clip(String(item.arguments ?? ''), MAX_HISTORY_MESSAGE_CHARS)}`);
        continue;
      }

      if (type === 'function_call_output') {
        // 工具结果包含本轮刚读回的正文，不能按“历史摘要”逐条裁剪。
        // 新旧结果采用同一种稳定序列化，保持 SessionBridge 已送达前缀一致；
        // 单次发送仍由 boundPrompt 按总预算保留头尾、压缩中间历史。
        blocks.push(`[工具结果]\n${textOf(item.output)}`);
        continue;
      }

      if (type === 'reasoning') continue;
    }
  }

  const tools = (request as unknown as { tools?: unknown }).tools;
  const toolList = Array.isArray(tools) ? tools as ToolLike[] : [];
  const allowed = options.allowedTools === undefined ? null : options.allowedTools;
  const manual = buildToolManual(toolList, allowed);
  const toolsInPrompt = manual ? manual.split('\n').filter(line => line.startsWith('- ')).length : 0;
  if (manual) {
    // 说明书与格式规则一起放在最前面：模型对开头的指令更服从，也便于聊天中段不再重复。
    head.unshift(`${manual}\n\n${TOOL_RULE}`);
  }
  const headText = head.join('\n\n');

  return {
    full: [headText, ...blocks].filter(part => part.length > 0).join('\n\n'),
    headChars: headText.length,
    images,
    toolsInPrompt,
    toolNames: manual ? manualToolNames(manual) : [],
    droppedTools: toolList.length - toolsInPrompt,
  };
}

/**
 * 助手回复拼回完整文本时用的块格式。
 *
 * 会话桥靠字面前缀判断续接，所以这里必须与 `flatten()` 用**同一套**格式：
 * 少了 `[助手]` 标记，前缀就对不上，每一轮都会被判成「历史被改写」而不停重建。
 */
export function assistantBlock(text: string): string {
  return text ? `\n\n[助手]\n${text}` : '';
}
