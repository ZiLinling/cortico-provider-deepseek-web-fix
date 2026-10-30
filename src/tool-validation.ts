import { Ajv, type AnySchema } from 'ajv';
import { LLMError } from 'cortico/providers/transport/errors.ts';
import type { ParsedCall, ToolLike } from './tools.ts';

/** 422 让框架明确报告输出校验错误，不触发传输层的自动重试。 */
export class ToolOutputError extends LLMError {
  constructor(code: string, detail: string) {
    super(`工具调用未执行：${detail}`, 422, JSON.stringify({ error: { code, message: detail } }));
    this.name = 'ToolOutputError';
  }
}

export class ToolCallValidator {
  private readonly tools: Map<string, ToolLike>;
  private readonly allowed: Set<string> | null;

  constructor(tools: readonly ToolLike[], allowed?: readonly string[]) {
    this.tools = new Map(tools.filter(tool => typeof tool.name === 'string').map(tool => [tool.name!, tool]));
    this.allowed = allowed ? new Set(allowed) : null;
  }

  get hasTools(): boolean { return this.tools.size > 0; }

  validate(call: ParsedCall): void {
    const batch = /first-of-(\d+)/.exec(call.form);
    if (batch && Number(batch[1]) > 1) {
      throw new ToolOutputError('multiple_tool_calls', '一次返回多个调用，无法按单次调用规则交付');
    }
    const tool = this.tools.get(call.name);
    if (!tool || (this.allowed && !this.allowed.has(call.name))) {
      throw new ToolOutputError('tool_not_available', `本轮未提供或未放行工具 ${call.name}`);
    }
    let args: unknown;
    try { args = JSON.parse(call.argumentsJson); }
    catch { throw new ToolOutputError('invalid_arguments_json', `${call.name} 的参数不是完整 JSON`); }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new ToolOutputError('arguments_not_object', `${call.name} 的参数必须是 JSON 对象`);
    }
    const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false,
      coerceTypes: false, useDefaults: false, removeAdditional: false });
    let validate;
    try { validate = ajv.compile((tool.parameters ?? { type: 'object' }) as AnySchema); }
    catch { throw new ToolOutputError('tool_schema_invalid', `${call.name} 的参数定义无法校验`); }
    if (!validate(args)) {
      throw new ToolOutputError('arguments_schema_mismatch', `${call.name} 参数不符合工具定义：${ajv.errorsText(validate.errors, {dataVar:'arguments',separator:'; '})}`);
    }
  }
}
