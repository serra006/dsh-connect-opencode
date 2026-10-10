# dsh-connect-opencode

把本机 **OpenCode**（`opencode serve`）里的**免费模型**接入 DeepSeek Harness（DSH）的模型选择器。

> 免费 = OpenCode provider 目录里 `cost.input / output / cache.read / cache.write` 全为 0、能输出文本、未废弃的模型。
> 具体有哪些免费模型由你的 OpenCode 配置决定（包括你自己添加的 provider）；没有免费模型时列表为空，见下方 FAQ。

## 安装

- **DSH 插件市场**：搜索 `dsh-connect-opencode` 一键安装（推荐）。
- **手动安装**：在 DSH profile 目录执行 `npm install dsh-connect-opencode`，并在 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 数组末尾加上 `"dsh-connect-opencode"`，然后重启 DSH。

## 运行前提

- 已安装 DSH 和 **OpenCode**（`opencode` 位于 `~/.opencode/bin`、npm 全局或 `PATH`）。
- OpenCode 里至少配置了一个**免费**模型/供应商（可用 `opencode models` 自查）。

## 设置（设置 > 模型）

安装后，DSH「设置 > 模型」页会出现 dsh-connect-opencode 卡片：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 是否向 DSH 提供 OpenCode 模型 |
| `binary` | `""` | opencode 可执行文件绝对路径；空 = 自动发现 |
| `autoRefreshMin` | `15` | 每隔多少分钟重扫一次免费模型（0 = 不重扫） |

也可以直接写进 profile 根 `cordis.patch.yml` 配置，无需界面：

```yaml
- id: dsh-connect-opencode
  name: dsh-connect-opencode
  config:
    enabled: true
    autoRefreshMin: 10
```

## 工作原理

```
DSH (pi-ai) ──OpenAI 兼容──▶ 本插件的本地 shim (127.0.0.1:<随机端口>)
                                  │  协议转换（流式 / 工具调用）
                                  ▼
                          opencode serve --pure（隔离 XDG 目录 + 随机端口 + Basic 鉴权拉起）
```

- **隔离实例**：插件自己拉起一个 `opencode serve --pure`，不加载全局插件、不占用你日常 OpenCode 的会话与状态；数据在 `~/.dsh/dsh-connect-opencode/` 下独立存放。
- **凭据复用**：为让自定义 provider 与登录态在隔离实例中可用，会把你的全局 `opencode.json(c)` 与 `auth.json`（API key）**复制**进该隔离目录——仅存于本机，绝不上传。
- **免费模型筛选**：从 `/provider` 目录筛出 cost 全 0、支持文本输出、未废弃的模型（覆盖所有 provider，含内置 Zen 与自定义 provider），刷新进 DSH 模型选择器。
- **工具执行权归 DSH**：OpenCode 原生工具（bash/read/write…）一律 `deny`，模型发起的工具调用转换为 OpenAI `tool_calls` 由 DSH 执行。

## CLI 自检

```sh
node bin/cli.js doctor   # opencode 可执行文件是否找到
node bin/cli.js models   # 列出发现的免费模型
node bin/cli.js chat "你好"   # 走完整链路发一条消息
```

## FAQ

**模型列表是空的？**
说明 OpenCode 当前没有 cost 全 0 的模型。先跑 `node bin/cli.js models` 看发现结果；需要免费模型可在 OpenCode 里配置带免费档的供应商（如 OpenCode Zen 免费档或你自己的免费 provider）。

## 已知边界

- **图片输入**：仅接受 base64 data URL（PNG/JPEG/WebP/GIF），整请求 ≤ 8 MB。
- **采样参数**：不转发 `temperature`/`max_tokens` 等；推理档位仅在模型声明 `variants` 时映射。
- **协议兼容**：OpenCode 端 `structured output` 字段名可能随其版本变化，若工具调用异常请先跑 `bin/cli.js chat` 验证并提 issue。

## 测试

`test/bridge.test.mjs` 用模拟 opencode 服务器端到端验证发现、模型列表、非流式、SSE 流式与工具信封协议：

```sh
node --test test/
```

## 许可 / 致谢

MIT。协议层移植并简化自 [`ow-bridge`](https://github.com/louchi1984-coder/ow-bridge)（LaoDing，MIT）；插件结构参考 [`dsh-connect-workbuddy`](https://github.com/dingminhua/dsh-connect-workbuddy)（dingminhua，MIT）。
