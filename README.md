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
| `autoRefreshMin` | `15` | 每隔多少分钟重新拉取一次 OpenCode 官方模型目录并刷新免费模型列表（0 = 不刷新）。刷新会在空闲（无进行中对话）时重启隔离实例，不打断当前会话。 |

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

## 免费模型的限制

本插件只是把 **OpenCode 自身的免费模型**桥接进 DSH，**不额外提供额度**。免费模型的额度、地区可用性与是否存续，均由上游（OpenCode / models.dev 及各 provider）决定，插件无法控制。下列情况可能随时发生：

- **额度 / 限流（`429`）**：OpenCode Zen 免费档按网络出口 IP 配额，且热门免费模型竞争激烈，高峰时段可能请求受限。
- **地区限制（`REGION_BLOCKED`）**：部分模型会按国家/地区屏蔽，对你的网络不可用。
- **免费标记 ≠ 保证可用**：目录里 `cost` 全 0 只表示“标称免费”，不代表一定可达或不会下线。
- **客户端限制（`403 FreeTierError`）**：OpenCode 对免费档有“仅限在 OpenCode 客户端内使用”的限制。本插件通过拉起官方 `opencode serve` 实例转发请求（与直连 Zen HTTP 接口的做法不同），当前可正常使用；但若上游调整政策，本插件同样会受影响，不承诺该方式长期有效。

命中上述错误时，插件会**如实透传**上游报错，不会把它误报成 API key 失效。若某模型持续受限，可在 `opencode models` 里换用其它免费模型，或降低推理档位。

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
