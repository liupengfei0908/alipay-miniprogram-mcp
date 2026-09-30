# alipay-miniprogram-mcp

支付宝小程序开发者工具 MCP 服务器 — 让 AI 助手（或任何 MCP 客户端）直接调用支付宝小程序开发者工具链，完成**编译验证、真机预览、日志收集与智能分析、代码上传、页面/功能/边界测试**等全套操作。

基于支付宝官方 CLI/SDK [minidev](https://registry.npmjs.org/minidev)（v2.2.5），无需逆向、无第三方非官方接口。

## 架构

```
MCP 客户端 (Claude / Cline / 任意 MCP 宿主)
   │  JSON-RPC (stdio)
   ▼
index.mjs  ─── MCP 服务器：22 个工具、日志落盘、会话管理
   │  行式 JSON RPC (stdio)
   ▼
src/worker.mjs ── minidev 执行器（独立进程，隔离噪音输出）
   │  SDK 调用
   ▼
minidev (官方 SDK) ──→ 支付宝开放平台 / 本地构建器 / IDE
```

worker 独立进程的意义：minidev 的控制台输出/进度条无法污染 MCP 的 JSON-RPC 流；同时 DevServer 的 `log/error/done` 事件被结构化转发，实现**实时日志收集**。

## 环境要求

- Node.js ≥ 20（已在 v20.19 验证）
- [小程序开发者工具 IDE](https://opendocs.alipay.com/mini/ide/overview)（Windows 默认安装路径自动探测）
- minidev 依赖已随本包安装（注意：需 `--ignore-scripts`，跳过 bufferutil 原生编译；缺失时 ws 自动回退纯 JS，不影响功能）

## 注册到 MCP 客户端

在 MCP 客户端配置文件中添加（路径换成你的绝对路径）：

```json
{
  "mcpServers": {
    "alipay-miniprogram": {
      "command": "node",
      "args": ["C:\\Users\\dhy_16\\Desktop\\桌\\deepseek0817\\alipay-miniprogram-mcp\\index.mjs"]
    }
  }
}
```

可选环境变量：

| 变量 | 说明 |
|---|---|
| `MP_DATA_DIR` | 数据目录（日志/二维码/状态），默认 `<项目>/data` |

## 首次使用

1. 调用 `mp_env_check` — 自检 Node/minidev/IDE/授权状态
2. 调用 `mp_login` — 立即返回授权二维码（图片存到 `data/qr/`），用支付宝 App 扫码
3. 调用 `mp_login_status` — 确认 `success` 后即可使用全部工具

> 长耗时工具（构建/预览/上传）可能超过 MCP 客户端默认 60s 超时：
> DeepSeek Harness 接入建议配 `toolCallTimeoutMs: 300000`；其他客户端如有超时设置项请调到 5 分钟。
> 登录已设计为非阻塞两段式，不受该超时影响。

> 首次构建如果提示缺构建资源，运行 `npx minidev setup-build` 初始化构建环境。

## 工具清单（22 个）

### 环境与授权
| 工具 | 说明 |
|---|---|
| `mp_env_check` | 环境自检：Node/minidev 版本、IDE 路径、授权状态、修复建议 |
| `mp_login` | 工具授权：**非阻塞**生成扫码二维码（图片 + 链接），立即返回 |
| `mp_login_status` | 查询授权状态：waiting / scanned / success / failed / idle |

### 构建与静态验证
| 工具 | 说明 |
|---|---|
| `mp_build` | **编译验证**：结构化构建结果，失败含错误详情与耗时 |
| `mp_project_analyze` | **项目静态分析**：页面文件完整性、组件引用、tabBar、分包、体积，分级问题清单 |
| `mp_validate_pages` | **页面验证**：按页面检查文件与配置（页面调试验证第一步） |

### 预览与调试
| 工具 | 说明 |
|---|---|
| `mp_preview` | **真机预览**：返回二维码 URL + PNG 文件，可指定入口页面/参数/场景值 |
| `mp_remote_debug` | **真机调试**：返回调试二维码与 Chrome DevTools 调试地址 |
| `mp_debug_stop` | 停止真机调试服务 |
| `mp_web_simulator` | **Web 模拟器**：浏览器端调试，无需真机 |
| `mp_ide_open` | 打开 IDE（自动探测 Windows 安装路径） |

### DevServer 与日志
| 工具 | 说明 |
|---|---|
| `mp_dev_start` | 启动 DevServer 长驻会话，**自动收集全部运行日志**（编译/错误/HMR） |
| `mp_dev_stop` | 停止 DevServer |
| `mp_logs_get` | 查询日志：按会话/级别/关键字/时间/条数过滤 |
| `mp_logs_analyze` | **日志智能分析**：错误分类聚类（JS异常/网络/路由/授权/渲染…）、时间线、修复建议 |
| `mp_logs_clear` | 清空日志缓冲 |

### 上传与版本管理
| 工具 | 说明 |
|---|---|
| `mp_upload` | 上传代码：版本号自动递增、描述、可自动设为体验版，过程日志收集 |
| `mp_app_list` | 账号下小程序列表（兼授权探针） |
| `mp_app_versions` | 已上传版本列表 |
| `mp_set_experience` | 设置体验版（返回体验二维码） |

### 测试验证（页面/功能/边界）
| 工具 | 说明 |
|---|---|
| `mp_test_matrix` | **生成边界测试矩阵**：18 种边界参数 × N 个页面（空值/零/负数/超大数/超长/emoji/SQL/XSS/编码…） |
| `mp_test_run` | **运行测试用例**：编译一次后为每个用例生成带页面+参数的真机预览二维码（构建缓存加速），扫码即测 |
| `mp_list_sessions` | 列出活跃会话与日志会话 |

## 典型工作流

### 1. 日常编译验证
```
mp_project_analyze → (静态问题) → mp_build → (编译错误) → 修复 → 重跑
```

### 2. 页面调试验证
```
mp_validate_pages（页面完整性）
→ mp_dev_start（开日志收集）
→ mp_preview { page: "pages/detail/detail", pageQuery: "id=123" }
→ 扫码查看 → mp_logs_analyze（该页报错汇总）
```

### 3. 功能逻辑验证
```
mp_dev_start → 正常操作小程序
→ mp_logs_get { level: "error" } → mp_logs_analyze（分类+建议）
```

### 4. 边界验证
```
mp_test_matrix { pages: [...], paramName: "id" }        # 先看用例集
→ mp_test_run { appId, pages: [...], caseLimit: 12 }     # 生成逐用例预览码
→ 真机逐个扫码 → mp_logs_analyze → 修复 → 重跑
```

### 5. 发布
```
mp_build → mp_upload { appId, versionDescription, experience: true } → mp_set_experience
```

## 数据目录

```
data/
├── logs/       # 日志 JSONL（每会话一个文件，可离线分析）
├── qr/         # 二维码 PNG（预览/登录/体验版/测试用例）
└── state.json  # 上次使用的项目路径
```

## 故障排查

| 现象 | 处理 |
|---|---|
| `ErrorCode: auth.NotAuthenticated` | 调用 `mp_login` 重新扫码授权 |
| 构建报缺资源/编译器下载失败 | `npx minidev setup-build`，或检查网络代理 |
| IDE 打不开 | `mp_ide_open` 传 `appPath` 指定安装目录 |
| 授权文件路径 | 默认在用户目录 `.minidev/`，也可在开放平台创建密钥后用 `identityKeyPath` |

## 已知限制（v1）

- **UI 自动化断言**：支付宝官方未开放类似微信 `miniprogram-automator` 的完整 UI 自动化协议；v1 的测试验证通过「页面+参数定向预览二维码 + DevServer 日志窗口」完成，扫码动作由人执行，报错由日志分析自动汇总。后续可基于 Web 模拟器 + CDP 做无头断言。
- 日志分析覆盖 DevServer 运行日志与上传日志；IDE 编辑器内部日志不在收集范围。
- 一次 `mp_test_run` 生成多个二维码，需逐个扫码。

## 开发

```bash
npm run smoke   # 端到端自测（含夹具项目静态分析回归）
```

测试夹具 `test/fixture-demo` 故意包含 4 处典型问题（页面缺 axml、tabBar 图标缺失、组件引用不完整、JSON 兼容性），用于验证静态分析能力。
