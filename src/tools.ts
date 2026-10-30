/**
 * 工具说明书 + 调用解析。
 *
 * DeepSeek 网页版**没有原生 function calling**，所以这里是提示词模拟：把工具说明写进
 * prompt，再从回答里把调用抠出来。这套做法天生不可靠，因此设计上遵循三条：
 *
 *   1. **说明书尽量短**：只写名字、一句话描述、参数名与类型。冗长的 JSON Schema 会挤占
 *      上下文，也会让模型忘记格式。
 *   2. **格式只要求一种**，但解析器容错多种。模型常见的手滑都要能吃下去。
 *   3. **解析失败绝不静默**：要么把原文当普通文本交出去（不丢内容），要么抛错。绝不假装
 *      「模型什么都没说」。
 */

export interface ToolLike {
  type?: string;
  name?: string;
  description?: string;
  parameters?: unknown;
  [key: string]: unknown;
}

export interface ParsedCall {
  name: string;
  /** 已经是合法 JSON 字符串，直接作为 function_call 的 arguments。 */
  argumentsJson: string;
  /** 给日志看：这一条是靠哪种格式解析出来的。 */
  form: string;
}

/** 一次只放行一个调用的提示词尾巴。 */
export const TOOL_RULE = [
  '[工具调用规则]',
  '需要调用工具时，只输出一行 JSON，不要解释、不要加代码块：',
  '{"tool_call":{"name":"工具名","arguments":{...}}}',
  '一次只调用一个工具，arguments 必须是合法 JSON 对象。',
  '是否调用、调用哪个，由上面的说明决定；这条只规定格式。',
  '如果上面的说明写明对方看不到你的正文，那么说话也必须通过工具。',
].join('\n');

/**
 * 每轮追加的短提醒。
 *
 * 抄自反代 `formatToolReminder`，它那里的注释把问题说得很清楚：
 * 「完整说明书在会话开头，**没有这行简短提醒的话，DeepSeek 会逐渐偏离协议**」。
 * 实测后果不是报错，而是模型开始用普通文本说话 —— 桌宠世界里那等于没回复，
 * 因为对方看不见消息正文，只看得见 `pet_say` 的气泡。
 *
 * 与反代原版的一处**故意不同**：原版结尾是 "Otherwise answer normally."，在桌宠
 * 世界里这句话等于允许模型用看不见的正文作答。这里改成把「要不要用、用哪个」交回
 * 上面的说明，本行只约束格式。
 */
export function toolReminder(names: readonly string[]): string {
  if (names.length === 0) return '';
  let list = names.join(', ');
  if (list.length > 1500) list = `${list.slice(0, 1497)}...`;
  return '[Tool reminder] Available tools: ' + list
    + '. To use one, reply with ONLY {"tool_call":{"name":"<function_name>","arguments":{...}}}'
    + ' (valid JSON, one tool, nothing else). Whether to use one — and which — follows the instructions'
    + ' above; this line only fixes the format. Never invent tool results.';
}

/** 说明书里实际写进去的工具名，按出现顺序。 */
export function manualToolNames(manual: string): string[] {
  return manual.split('\n')
    .filter(line => line.startsWith('- '))
    .map(line => line.slice(2, line.indexOf('：') >= 0 ? line.indexOf('：') : undefined).trim())
    .filter(Boolean);
}

function typeOf(schema: unknown): string {
  if (!schema || typeof schema !== 'object') return 'any';
  const node = schema as { type?: unknown; enum?: unknown };
  if (Array.isArray(node.enum)) return node.enum.map(value => JSON.stringify(value)).join('|');
  if (typeof node.type === 'string') return node.type;
  return 'any';
}

function describeParams(parameters: unknown): string {
  if (!parameters || typeof parameters !== 'object') return '（无参数）';
  const node = parameters as { properties?: Record<string, unknown>; required?: unknown };
  const properties = node.properties;
  if (!properties || typeof properties !== 'object') return '（无参数）';
  const required = new Set(Array.isArray(node.required) ? node.required.map(String) : []);
  const parts = Object.entries(properties).map(([name, raw]) => {
    const description = (raw && typeof raw === 'object' && typeof (raw as { description?: unknown }).description === 'string')
      ? String((raw as { description: string }).description).split('\n')[0]!.slice(0, 60)
      : '';
    return `${name}:${typeOf(raw)}${required.has(name) ? '' : '?'}${description ? ` — ${description}` : ''}`;
  });
  return parts.join('; ');
}

/**
 * 把工具列表压成一段说明书。`allowed` 为 `null` 表示全部放行（阶段一：先全开再收敛）。
 */
export function buildToolManual(tools: readonly ToolLike[], allowed: readonly string[] | null): string {
  const usable = tools.filter(tool => typeof tool.name === 'string' && tool.name.trim());
  const selected = allowed === null ? usable : usable.filter(tool => allowed.includes(tool.name!));
  if (selected.length === 0) return '';
  const lines = ['[可用工具]'];
  for (const tool of selected) {
    const description = String(tool.description ?? '').replace(/\s+/g, ' ').slice(0, 160);
    lines.push(`- ${tool.name}：${description}`);
    lines.push(`  参数：${describeParams(tool.parameters)}`);
  }
  return lines.join('\n');
}

/** 输出以这些形状开头时，先按「可能是调用」处理，攒完整再判断。 */
export function looksLikeToolCall(text: string): boolean {
  const head = text.replace(/^\s+/, '').slice(0, 24).toLowerCase();
  return head.startsWith('{') || head.startsWith('<') || head.startsWith('tool_call');
}

function asArguments(value: unknown): string | null {
  if (value === undefined || value === null) return '{}';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return '{}';
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      return null;
    }
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return null;
}

function shapeOf(value: unknown, form: string): ParsedCall | null {
  if (!value || typeof value !== 'object') return null;
  const node = value as Record<string, unknown>;

  const single = node.tool_call ?? node.function_call;
  if (single && typeof single === 'object') {
    const call = single as Record<string, unknown>;
    const name = typeof call.name === 'string' ? call.name : typeof call.tool === 'string' ? call.tool : '';
    const argumentsJson = asArguments(call.arguments ?? call.parameters ?? call.args);
    if (name && argumentsJson) return { name, argumentsJson, form };
  }

  const many = node.tool_calls ?? node.function_calls;
  if (Array.isArray(many) && many.length > 0) {
    // 一次只交一个：上游网页版本来也只答一句话，多交会让 Core 以为有并行调用。
    return shapeOf({ tool_call: many[0] }, `${form}/first-of-${many.length}`);
  }

  // 裸的 {"name":...,"arguments":...}：只在没有更明确的信封时才认，避免误吞普通数据。
  if (typeof node.name === 'string') {
    const argumentsJson = asArguments(node.arguments ?? node.parameters ?? node.args);
    if (argumentsJson) return { name: node.name, argumentsJson, form };
  }
  return null;
}

/** 从文本里收集所有平衡的 JSON 对象（跳过字符串里的括号）。 */
function balancedObjects(text: string, limit = 24): string[] {
  const found: string[] = [];
  for (let start = text.indexOf('{'); start >= 0 && found.length < limit; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index++) {
      const char = text[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          found.push(text.slice(start, index + 1));
          break;
        }
      }
    }
  }
  return found;
}

function tryJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // 模型偶尔会把 JSON 包在代码块里，多试一层。
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

/**
 * 从一段模型输出里找出工具调用。找不到返回 null —— 调用方应当把它当普通文本处理。
 */
export function parseToolCall(text: string): ParsedCall | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // 1) 整段就是一个 JSON。
  const whole = tryJson(trimmed);
  if (whole) {
    const shaped = shapeOf(whole, 'whole-json');
    if (shaped) return shaped;
  }

  // 工具名在 XML 属性里时，标签内只有参数，不能按 JSON 调用信封解析。
  // 只接受完整、独立的单次调用；缺尾标签或无效参数不能猜成可执行操作。
  if (/^<tool_call\s+name\s*=/i.test(trimmed)) {
    const attributed = /^<tool_call\s+name\s*=\s*(["'])([A-Za-z_][\w.-]*)\1\s*>([\s\S]*?)<\/tool_call\s*>$/i.exec(trimmed);
    if (!attributed) return null;
    const args = tryJson(attributed[3]!.trim());
    if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
    return { name: attributed[2]!, argumentsJson: JSON.stringify(args), form: 'xml-name-attribute' };
  }

  // 2) `<tool_call>…</tool_call>` 以及 DeepSeek 的 DSML 变体。
  const tagged = /<[^>]*(?:tool_call|｜DSML｜)[^>]*>([\s\S]*?)<\/[^>]*>/i.exec(trimmed);
  if (tagged?.[1]) {
    const inner = tagged[1].trim();
    const parsed = tryJson(inner);
    if (parsed) {
      const shaped = shapeOf(parsed, 'xml-tag');
      if (shaped) return shaped;
    }
    const scanned = scanObjects(inner, 'xml-tag/scan');
    if (scanned) return scanned;
  }

  // 3) `TOOL_CALL: name` 后面跟一段 arguments。
  const named = /TOOL_?CALL\s*[:：]\s*([A-Za-z_][\w.-]*)/i.exec(trimmed);
  if (named?.[1]) {
    const after = trimmed.slice(named.index + named[0].length);
    const objectStart = after.indexOf('{');
    const candidate = objectStart >= 0 ? after.slice(objectStart) : '{}';
    for (const raw of balancedObjects(candidate)) {
      const parsed = tryJson(raw);
      const argumentsJson = asArguments(parsed);
      if (argumentsJson) return { name: named[1], argumentsJson, form: 'tool-call-line' };
    }
    return { name: named[1], argumentsJson: '{}', form: 'tool-call-line/no-args' };
  }

  // 4) 兜底：正文里散着一个带信封的 JSON（模型常常前后各说一句话）。
  return scanObjects(trimmed, 'scanned');
}

function scanObjects(text: string, form: string): ParsedCall | null {
  for (const raw of balancedObjects(text)) {
    const parsed = tryJson(raw);
    if (!parsed) continue;
    const shaped = shapeOf(parsed, form);
    if (shaped) return shaped;
  }
  return null;
}
