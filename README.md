# DeepSeek Web（修复版）

基于 [cortico-provider-deepseek-web 0.6.1](https://www.npmjs.com/package/cortico-provider-deepseek-web/v/0.6.1)
修改的 Cortico / Coopanion provider 插件。provider 是连接模型服务的适配插件。
上游 npm 发布者为 lian0721；原有网页登录、传输、图片和会话管理等功能来自上游。
本项目维护修复，不代表上游发布的更新。版本：0.2.2。

## 修复内容

- 提取工具名和完整参数，兼容已知的标签变体及部分外层定界符缺失。
- 按本轮工具名单及参数定义校验，通过后生成标准 function_call。
- 清理正文开头完整的 ds_safety 分类前缀，保留后面的实际回复或调用。
- 只有分类前缀时不创建聊天消息，也不补造工具调用；日志会提示没有收到实际内容。

参数缺失或校验失败时明确报错，不猜参数，不自动请求模型重写。
工具名单由 coo 每轮提供，无须按新插件硬编码工具名。

## 安装

需要 Node.js 22 或以上，以及支持扩展 API 6 的 Cortico / Coopanion。

1. 下载本仓库代码并解压，找到包含 package.json 的插件目录。
2. 在 coo 扩展页使用本机目录安装；也可以在 coo 的扩展目录执行：

   `corepack pnpm add "插件目录的绝对路径"`

3. 重启 coo，在模型供应商页新建端点，选择 **DeepSeek Web（修复版）**。
4. 保存端点后通过登录面板登录 DeepSeek，再将该端点设为当前供应商。

包名：`cortico-provider-deepseek-web-fix`；provider id：`deepseek-web-fix`。
它与上游插件的模块标识不同，可以并存。

## 使用边界

工具调用通过提示词模拟，模型仍可能产生不符合约定的输出。
格式与参数校验不能证明业务含义正确；工具执行结果以实际回执为准。
本插件使用 DeepSeek 网页非公开接口，依赖网页接口的可用性。
登录凭据保存在部署的端点目录，插件不附带登录信息。

## 来源与许可

基础代码取自上游 0.6.1 发行包。原有功能和版权归上游贡献者；
本分支修改范围为调用提取、校验、消息分类及独立模块配置。
上游说明还注明协议实现来自 [FreeDeepseekAPI](https://github.com/ForgetMeAI/FreeDeepseekAPI)，
部分参数及实测结论参考 [dsh-deepseek-web-login](https://github.com/cv-superding/dsh-deepseek-web-login)。
保留原 [MIT 许可证及版权声明](LICENSE)。本仓库的本地提交历史不包含上游 Git 历史。
