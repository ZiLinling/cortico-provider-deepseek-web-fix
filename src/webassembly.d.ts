/**
 * Node 22 在运行时提供 WebAssembly，但项目的 tsconfig 刻意不带 `DOM` lib（服务端代码
 * 不该看见 `window`），而 @types/node 不为它声明类型。这里只声明我们实际用到的那几个
 * 成员，范围小到不会掩盖任何错误。
 */
declare namespace WebAssembly {
  interface Module {
    readonly __module: unique symbol;
  }
  interface Memory {
    readonly buffer: ArrayBuffer;
  }
  interface Instance {
    readonly exports: Record<string, unknown>;
  }
  function compile(bytes: ArrayBuffer | Uint8Array): Promise<Module>;
  function instantiate(module: Module, imports?: Record<string, unknown>): Promise<Instance>;
}
