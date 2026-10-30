/**
 * DeepSeek 的 SHA3 工作量证明。
 *
 * 算法本体在上游的 WASM 模块里，地址随网页版本变化，因此 `wasmUrl` 跟着凭证一起存。
 * 这里做两件事：
 *   1. 按 URL 缓存**编译后的模块**，一次请求只实例化一次（实例带干净的线性内存）；
 *   2. 下载失败不缓存，下一次重试重新取，并给下载一个硬超时。
 *
 * 移植自 FreeDeepseekAPI 的 `lib/pow.js`，改为 ESM 并补了显式错误类型。
 */

const moduleCache = new Map<string, Promise<WebAssembly.Module>>();

/** 上游挑战里参与 PoW 的字段。 */
export interface PowChallenge {
  algorithm: string;
  challenge: string;
  salt: string;
  signature: string;
  difficulty: number;
  /** 秒级过期时间，拼进前缀。 */
  expire_at: number;
}

export class PowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PowError';
  }
}

async function loadModule(wasmUrl: string, timeoutMs: number): Promise<WebAssembly.Module> {
  if (!wasmUrl) throw new PowError('缺少 POW 的 WASM 地址，凭证可能不完整');
  const cached = moduleCache.get(wasmUrl);
  if (cached) return cached;
  const pending = (async () => {
    const response = await fetch(wasmUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new PowError(`下载 POW WASM 失败：HTTP ${response.status}`);
    return WebAssembly.compile(await response.arrayBuffer());
  })();
  moduleCache.set(wasmUrl, pending);
  // 失败不留在缓存里，否则一次网络抖动会让这个 URL 永久不可用。
  pending.catch(() => moduleCache.delete(wasmUrl));
  return pending;
}

/** 解一个挑战，返回 nonce。同一个答案只能用于一次 completion。 */
export async function solvePow(challenge: PowChallenge, wasmUrl: string, timeoutMs = 15_000): Promise<number> {
  const module = await loadModule(wasmUrl, timeoutMs);
  const instance = await WebAssembly.instantiate(module, { wbg: {} });
  const exports = instance.exports as unknown as Record<string, unknown> & { memory: WebAssembly.Memory };

  const alloc = exports.__wbindgen_export_0 as (length: number, align: number) => number;
  const stack = exports.__wbindgen_add_to_stack_pointer as (delta: number) => number;
  const solve = exports.wasm_solve as (
    stackPointer: number, challengePointer: number, challengeLength: number,
    prefixPointer: number, prefixLength: number, difficulty: number,
  ) => void;

  const encoder = new TextEncoder();
  const prefix = `${challenge.salt}_${challenge.expire_at}_`;
  const challengeBytes = encoder.encode(challenge.challenge);
  const prefixBytes = encoder.encode(prefix);

  const challengePointer = alloc(challengeBytes.length, 1) >>> 0;
  const prefixPointer = alloc(prefixBytes.length, 1) >>> 0;
  new Uint8Array(exports.memory.buffer, challengePointer, challengeBytes.length).set(challengeBytes);
  new Uint8Array(exports.memory.buffer, prefixPointer, prefixBytes.length).set(prefixBytes);

  const stackPointer = stack(-16);
  try {
    solve(stackPointer, challengePointer, challengeBytes.length, prefixPointer, prefixBytes.length, challenge.difficulty);
    const view = new DataView(exports.memory.buffer);
    const code = view.getInt32(stackPointer, true);
    const answer = view.getFloat64(stackPointer + 8, true);
    // code 0 = 无解；nonce 为 0 是合法答案，不能用真假值判断。
    if (code === 0 || !Number.isFinite(answer) || answer < 0) throw new PowError('PoW 无解，挑战可能已过期');
    return Math.floor(answer);
  } finally {
    stack(16);
  }
}

/** 上游要的 `X-DS-PoW-Response`：一组字段的 base64 编码 JSON。 */
export function powHeader(challenge: PowChallenge, answer: number, targetPath: string): string {
  return Buffer.from(JSON.stringify({
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: targetPath,
  })).toString('base64');
}

/** 只给测试用：清掉模块缓存。 */
export function _resetPowCache(): void {
  moduleCache.clear();
}
