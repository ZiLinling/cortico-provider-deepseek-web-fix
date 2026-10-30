/**
 * 会话桥：Cortico 的「无状态重放」↔ DeepSeek Web 的「服务端有状态会话」。
 *
 * 两边的模型天生相反：
 *   - Cortico 每次请求都带完整历史（它假设上游无状态）；
 *   - DeepSeek Web 的 `chat_session_id` + `parent_message_id` 是一条服务端链，历史存在它那里。
 *
 * 桥的规则（对应 FreeDeepseekAPI 文档 4.2，去掉工具结果后的简化版）：
 *   - **续接**：新请求的完整文本 = 上次已送达文本 + 尾巴 → 只把尾巴发进同一条 chat；
 *   - **重建**：历史被改写 / 压缩 / system prompt 变了 / 没有新增 → 新建 chat，发完整文本；
 *   - **兜底**：轮数与时长到了就重建。
 *
 * 上下文容量**不在这里判断**：Cortico 的 Core 已经用 token 记账（`hardTokens` =
 * 窗口 − 单轮生成上限），并在越线时做「上下文交接」。桥要是自己再按字符数截一刀，
 * 两套账必然打架——Core 认为还有空间，桥却每轮都判「超限」，于是每轮重建、模型
 * 每轮丢掉上下文，表现为永远接不上话。容量交给 Core，见 provider 的 `contextOverflow`。
 *
 * 判定必须可解释：每次决定都写一条 reason，出问题时能回答「这一轮为什么重建」。
 */

/** 一条 chat 的重建上限；上游自己也有上限，这里更保守一点。 */
const MAX_TURNS = 100;
const MAX_AGE_MS = 2 * 60 * 60 * 1000;
/**
 * 整条 chat 累积文本（送出的 + 回来的）的重建阈值。
 *
 * 抄自反代 `MAX_SESSION_CONTEXT_CHARS`（默认 `MAX_UPSTREAM_PROMPT_CHARS * 3`）。
 * **注意别和单次请求预算搞混**：单次预算超了截中间；这里是「一条 chat 攒多少就换一条」。
 * 单次预算现在是 100000，按同样的 3 倍留 240000，换 chat 的频率不跟着变。
 */
const MAX_SESSION_CHARS = 240_000;

/** 两个字符串的公共前缀长度，用于诊断「从第几个字开始对不上」。 */
function commonPrefix(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a.charCodeAt(index) === b.charCodeAt(index)) index += 1;
  return index;
}

export interface SessionEntry {
  chatSessionId: string;
  parentMessageId: number | null;
  /** 上一次送进这条 chat 的完整文本，用于判断下一轮是不是「已知前缀 + 尾巴」。 */
  delivered: string;
  turns: number;
  createdAt: number;
  busy: boolean;
}

export type PlanMode = 'continue' | 'fresh';

export interface Plan {
  mode: PlanMode;
  /** 实际发给上游的 prompt。 */
  prompt: string;
  chatSessionId?: string;
  parentMessageId?: number | null;
  /** 给日志看的一句话：这一轮为什么这么走。 */
  reason: string;
}

export class SessionBridge {
  private readonly entries = new Map<string, SessionEntry>();
  /** 每条 chat 的当前占用者，避免同一 chat 并发写入（上游一次只答一个）。 */
  private readonly inflight = new Set<string>();

  /**
   * 决定这一轮怎么发。
   * `forceFresh` 用于重试：上一次尝试失败后，同一条 chat 的状态不再可信。
   */
  plan(key: string, fullPrompt: string, forceFresh = false): Plan {
    const entry = this.entries.get(key);
    if (forceFresh) {
      if (entry) this.entries.delete(key);
      return { mode: 'fresh', prompt: fullPrompt, reason: '上一次尝试失败，重建 chat' };
    }
    if (!entry) return { mode: 'fresh', prompt: fullPrompt, reason: '首次对话' };
    if (entry.busy || this.inflight.has(key)) {
      return { mode: 'fresh', prompt: fullPrompt, reason: '上一条 chat 仍在生成，另起一条' };
    }
    if (entry.turns >= MAX_TURNS) {
      this.entries.delete(key);
      return { mode: 'fresh', prompt: fullPrompt, reason: `已达 ${MAX_TURNS} 轮上限` };
    }
    if (Date.now() - entry.createdAt > MAX_AGE_MS) {
      this.entries.delete(key);
      return { mode: 'fresh', prompt: fullPrompt, reason: 'chat 超过 2 小时' };
    }
    if (entry.delivered.length > MAX_SESSION_CHARS) {
      this.entries.delete(key);
      return {
        mode: 'fresh',
        prompt: fullPrompt,
        reason: `chat 累积超过上限（${entry.delivered.length} > ${MAX_SESSION_CHARS}），换一条`,
      };
    }
    // 已知前缀 + 非空尾巴才叫续接；只是重复上次内容时上游不会给出新回答。
    if (fullPrompt.startsWith(entry.delivered)) {
      const tail = fullPrompt.slice(entry.delivered.length);
      if (tail.trim()) {
        return {
          mode: 'continue',
          prompt: tail.replace(/^\s+/, ''),
          chatSessionId: entry.chatSessionId,
          parentMessageId: entry.parentMessageId,
          reason: `续接，只发新增的 ${tail.trim().length} 字`,
        };
      }
      return { mode: 'fresh', prompt: fullPrompt, reason: '没有新增内容，重建 chat' };
    }
    this.entries.delete(key);
    const shared = commonPrefix(entry.delivered, fullPrompt);
    return {
      mode: 'fresh',
      prompt: fullPrompt,
      reason: `历史被改写或压缩（已送达 ${entry.delivered.length}，新 ${fullPrompt.length}，共同前缀 ${shared}，差异从第 ${shared + 1} 字开始）`,
    };
  }

  /** 新 chat 建好后登记。`turns` 从此由 `turnDone()` 统一累加，不在这里预置。 */
  open(key: string, chatSessionId: string, fullPrompt: string): void {
    this.entries.set(key, {
      chatSessionId,
      parentMessageId: null,
      delivered: fullPrompt,
      turns: 0,
      createdAt: Date.now(),
      busy: false,
    });
  }

  /** 上游回了消息 id：下一轮要拿它当 `parent_message_id`。 */
  messageIds(key: string, responseMessageId: number | undefined): void {
    if (responseMessageId === undefined) return;
    const entry = this.entries.get(key);
    if (entry) entry.parentMessageId = responseMessageId;
  }

  /** 这一轮的完整文本正式算送达。 */
  delivered(key: string, fullPrompt: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.delivered = fullPrompt;
  }

  turnDone(key: string): void {
    const entry = this.entries.get(key);
    if (entry) {
      entry.turns += 1;
      entry.busy = false;
    }
    this.inflight.delete(key);
  }

  markInflight(key: string, on: boolean): void {
    if (on) this.inflight.add(key);
    else this.inflight.delete(key);
  }

  /** 只给测试。 */
  inspect(key: string): SessionEntry | undefined {
    return this.entries.get(key);
  }
}
