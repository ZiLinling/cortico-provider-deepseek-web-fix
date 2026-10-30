/**
 * 请求闸门：串行 + 随机间隔 + 滚动窗口限速 + 长任务保护。
 *
 * 这套参数不是拍脑袋来的，抄自 `dsh-deepseek-web-login`（Apache-2.0）的实测结论：
 *
 *   - 同一账号**同时只能生成一条**，并发生成会被直接拒绝，实测更严重的是账号级限制：
 *     两个窗口并发生成，不到 6 分钟就触发 **1 天**的临时封禁。
 *   - **固定间隔的方差≈0**，统计上就是最明显的「定时器特征」；真人打字不是等距的。
 *     所以间隔取 `[min, max]` 区间内随机。
 *   - 间隔只保证「两次不挨太近」，管不了「连着几十分钟不停发」。所以还有两道闸：
 *     连续 N 次后强制长休，以及滚动窗口（默认 30 分钟最多 20 次）。
 *   - 「连续」的判定是**距上次请求超过 10 分钟**才算人歇过。实测「十几发一波、
 *     隔一两分钟再来一波」会把 2 分钟门槛洗掉，长休从此永不触发。
 *
 * 这些调整**降低**被识别为自动化的概率，**不构成「不会被封」的保证**。
 */
import type { Logger } from 'cortico/core/types.ts';

export interface ThrottleOptions {
  /** 两次请求之间的间隔区间（毫秒）。上下限相等＝固定间隔（不推荐）。 */
  minIntervalMs?: number;
  maxIntervalMs?: number;
  /** 滚动窗口长度与窗口内允许的请求数；`maxInWindow = 0` 关掉窗口限速。 */
  windowMs?: number;
  maxInWindow?: number;
  /** 连续这么多次之后强制长休一次。 */
  longRunThreshold?: number;
  /** 长休区间（毫秒）。 */
  longRestMinMs?: number;
  longRestMaxMs?: number;
  /** 空闲超过这么久就算「人歇过了」，连续计数清零。 */
  idleResetMs?: number;
  log?: Logger;
}

export const THROTTLE_DEFAULTS = {
  minIntervalMs: 2_000,
  maxIntervalMs: 4_000,
  windowMs: 30 * 60_000,
  maxInWindow: 20,
  longRunThreshold: 15,
  longRestMinMs: 60_000,
  longRestMaxMs: 180_000,
  idleResetMs: 10 * 60_000,
} as const;

interface Resolved extends Required<Omit<ThrottleOptions, 'log'>> {
  log?: Logger;
}

function resolve(options: ThrottleOptions): Resolved {
  const pick = (value: number | undefined, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
  const min = pick(options.minIntervalMs, THROTTLE_DEFAULTS.minIntervalMs);
  const max = Math.max(min, pick(options.maxIntervalMs, THROTTLE_DEFAULTS.maxIntervalMs));
  const restMin = pick(options.longRestMinMs, THROTTLE_DEFAULTS.longRestMinMs);
  return {
    minIntervalMs: min,
    maxIntervalMs: max,
    windowMs: pick(options.windowMs, THROTTLE_DEFAULTS.windowMs),
    maxInWindow: pick(options.maxInWindow, THROTTLE_DEFAULTS.maxInWindow),
    longRunThreshold: Math.max(1, pick(options.longRunThreshold, THROTTLE_DEFAULTS.longRunThreshold)),
    longRestMinMs: restMin,
    longRestMaxMs: Math.max(restMin, pick(options.longRestMaxMs, THROTTLE_DEFAULTS.longRestMaxMs)),
    idleResetMs: pick(options.idleResetMs, THROTTLE_DEFAULTS.idleResetMs),
  };
}

/**
 * 所有请求排一条队，前一个结束才轮到下一个。
 *
 * 注入 `now` / `sleep` 是为了能在测试里把时间拨快，不真的等几分钟。
 */
export class RequestGate {
  private readonly opts: Resolved;
  private chain: Promise<unknown> = Promise.resolve();
  /** 用显式标志而不是「时间戳是否为 0」：假时钟从 0 起跳时后者会误判。 */
  private started = false;
  private finished = false;
  private lastFinishedAt = 0;
  private lastStartAt = 0;
  private consecutive = 0;
  /** 最近 `windowMs` 内每次请求的发起时刻。 */
  private stamps: number[] = [];

  constructor(
    options: ThrottleOptions = {},
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
  ) {
    this.opts = resolve(options);
  }

  /** 当前配置快照，供日志与面板展示。 */
  describe(): Record<string, number> {
    const { log: _log, ...rest } = this.opts;
    return rest;
  }

  /** 排队执行；返回 `fn` 的结果。 */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(() => this.execute(fn), () => this.execute(fn));
    // 队尾只关心「排到没有」，不传播失败。
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }

  private randomBetween(min: number, max: number): number {
    if (max <= min) return min;
    return min + Math.floor(Math.random() * (max - min));
  }

  private async execute<T>(fn: () => Promise<T>): Promise<T> {
    const start = this.now();

    // 空闲够久 = 人歇过了，连续计数清零。
    if (this.started && start - this.lastStartAt > this.opts.idleResetMs) {
      this.consecutive = 0;
      this.stamps = [];
    }

    let restMs = 0;
    let reason = '';

    // 滚动窗口：这段时间一共发了多少次。小间隙洗不掉。
    if (this.opts.maxInWindow > 0) {
      this.stamps = this.stamps.filter(at => start - at < this.opts.windowMs);
      if (this.stamps.length >= this.opts.maxInWindow) {
        restMs = this.randomBetween(this.opts.longRestMinMs, this.opts.longRestMaxMs);
        reason = `近 ${Math.round(this.opts.windowMs / 60_000)} 分钟已发 ${this.stamps.length} 次（上限 ${this.opts.maxInWindow}）`;
        this.stamps = [];
        this.consecutive = 0;
      }
    }

    // 长任务保护：连着太多次不停发。
    if (restMs === 0 && this.consecutive >= this.opts.longRunThreshold) {
      restMs = this.randomBetween(this.opts.longRestMinMs, this.opts.longRestMaxMs);
      reason = `连续 ${this.consecutive} 次未歇`;
      this.consecutive = 0;
    }

    if (restMs > 0) {
      this.opts.log?.warn(`DeepSeek Web：${reason}，长休 ${Math.round(restMs / 1000)}s`);
      await this.sleep(restMs);
    }

    // 与上一次**结束**之间至少隔一个随机区间：长回答之后不会白等。
    const gap = this.randomBetween(this.opts.minIntervalMs, this.opts.maxIntervalMs);
    const wait = this.finished ? this.lastFinishedAt + gap - this.now() : 0;
    if (wait > 0) await this.sleep(wait);

    this.lastStartAt = this.now();
    this.started = true;
    this.stamps.push(this.lastStartAt);
    this.consecutive += 1;
    try {
      return await fn();
    } finally {
      this.lastFinishedAt = this.now();
      this.finished = true;
    }
  }
}
