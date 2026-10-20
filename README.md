# DockerBrowserMcp

通过 MCP 控制服务器上的独立无头 Chromium。创建实例时指定 **UA、页面视口、HTTP/SOCKS5 代理和鉴权**，随后执行导航、点击、输入、多标签页、iframe、上传下载及截图。

Docker 服务不绑定网站、Skill 或模型，不提供 Web 管理页，也不开放公网端口。Agent 通过 **SSH → docker exec → MCP stdio** 调用；容器内的常驻进程持有实例，MCP 连接结束后实例按超时策略保留。

## 1. 构建并启动

需要 Linux Docker，建议先为 3 个并发实例预留 2 CPU / 4 GB 内存，再按实际网页调整。镜像使用固定版本 Playwright 及其官方浏览器运行环境。

```sh
git clone git@github.com:okteam99/DockerBrowserMcp.git
cd DockerBrowserMcp
docker build -t docker-browser-mcp:0.1.0 .
docker run -d --init \
  --name docker-browser-mcp \
  --restart unless-stopped \
  --shm-size=1g \
  --memory=4g --cpus=2 --pids-limit=512 \
  -v browser-mcp-data:/data \
  docker-browser-mcp:0.1.0
```

镜像需要自行构建，目前没有预发布 registry 地址。不要添加 `-p`、`--privileged` 或 Docker socket 挂载。

```sh
docker exec docker-browser-mcp node dist/cli.js health
docker logs --tail 30 docker-browser-mcp
```

`health` 输出 `status: succeeded` 表示管理进程可用；是否能启动浏览器需通过创建实例验证。

## 2. 配置 MCP 客户端

通用 MCP JSON 配置（把 `browser-host` 替换成已配置 SSH key 的服务器别名）：

```json
{
  "mcpServers": {
    "docker-browser": {
      "command": "ssh",
      "args": [
        "-T", "-o", "BatchMode=yes", "browser-host",
        "docker", "exec", "-i",
        "-e", "MCP_PRINCIPAL=agent-main",
        "docker-browser-mcp", "node", "dist/cli.js", "stdio"
      ]
    }
  }
}
```

同机连接使用 `docker` 为 command，args 从 `exec` 开始。**必须 `-i`，不能 `-t`**；SSH 登录脚本不能向 stdout 打印欢迎语，stdout 仅传 MCP JSON-RPC。

`MCP_PRINCIPAL` 默认为 `default`。同一 principal 的连接共享实例与产物，适合断线重连；不同 principal 的工具调用不可相互查询。principal 是可信接入配置中的命名空间，**不是独立认证机制**：有 Docker/SSH 权限的用户可以修改它。不要给不可信用户通用 Docker 权限；多租户需独立容器及受限制的 SSH 接入。

## 3. 创建指定环境

调用 `create_instance`：

```json
{
  "user_agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  "viewport": { "width": 412, "height": 915 },
  "mobile": { "enabled": true, "touch": true, "device_scale_factor": 2.625 },
  "locale": "en-US",
  "timezone": "America/New_York",
  "proxy": {
    "server": "socks5://proxy.example.com:1080",
    "username": "your-user",
    "password": "your-password"
  }
}
```

UA 示例只用于展示配置，不表示真实设备或匹配当前 Chromium 的浏览器版本。可传任意 UA，但现代网站还可能读取 Client Hints。服务返回实际 UA、viewport、layout_viewport、screen、touch_points 和 client_hints，**不声称完整伪装或反检测**。

- 支持 `http://`、`https://` 上游和 `socks5://`；密码使用独立字段，不嵌入 URL。
- 省略代理表示明确的直连模式；指定代理失败后不会切到直连。
- viewport 是 CSS 像素的页面视口。移动页面没有 viewport meta 时，layout_viewport 可能约为 980px，这是浏览器布局行为，不能与指定的设备宽度混淆。
- 所有参数创建后固定，切换环境需创建新实例。
- 返回 `instance_id` 和一个初始空白页的 `page_id`。

调用 `verify_environment` 校验实际出口，默认请求 `https://api.ipify.org?format=json`，会向该第三方透露出口 IP 和 UA。可用 `check_url` 换成自己的 JSON `{ "ip": "..." }` 端点。服务不内置国家数据库，国家需使用可信源另行核实。

## 4. 使用预配置代理

```sh
mkdir -p config
cp config/proxies.example.json config/proxies.json
# 编辑代理地址、用户名和密码，勿提交真实凭据到 Git。
```

启动容器时额外挂载（已启动的容器需要重新创建，数据卷可保留）：

```sh
--mount type=bind,src="$(pwd)/config/proxies.json",dst=/config/proxies.json,readonly
```

文件须可被容器非 root 用户读取。调用 `list_proxies` 获取名称，随后：

```json
{ "proxy_ref": "us", "viewport": { "width": 390, "height": 844 } }
```

`proxy` 与 `proxy_ref` 互斥。修改挂载文件后，下一次创建实例会重新读取；现有实例不变。

## 5. 正常操作流程

1. `create_instance` → 保存实例和页面 ID。
2. `verify_environment` → 检查真实 IP，确认手机属性。
3. `navigate` → 打开目标 URL。
4. `snapshot` → 读取当前页面和元素引用。
5. `interact` → 点击、输入等，页面变化后重新 snapshot。
6. `list_pages` → 获取弹窗或新标签页，不依赖当前焦点。
7. `get_diagnostics` / `screenshot` → 获取诊断和截图。
8. `close_instance` → 结束后主动释放资源。

[验证记录](docs/validation.md) · [完整 MCP 接口](docs/mcp-api.md) · [JSON Schema](docs/mcp-tools.json) · [Agent 流程示例](docs/agent-workflow.md) · [需求草案](docs/requirements-v1.md)

## 6. 上传下载和产物

下载自动捕获。先 `list_downloads`，再按需 `wait_for` 等待下载完成，通过 `get_artifact` 分块获取 base64 字节。返回 SHA-256 可供客户端校验。MIME 对未知下载统一使用 `application/octet-stream`，不会把扩展名当内容验证。

截图完整获取且为 PNG 时，MCP 会同时返回图片内容。产物不提供公网 URL，也不返回任意宿主路径。

上传：`put_artifact` 接收已授权文件的 base64（单文件最多 512 KiB），再 `upload_file` 将 artifact_id 设置到页面 file input。也可上传自己此前下载的产物。V1 不接受任意服务器路径，不执行文件。

文件名、页面内容和截图仍可能含业务敏感信息，调用者应按场景授权和保留策略处理。

## 7. 配置项

通过 `docker run -e NAME=value` 设置：

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `MAX_INSTANCES` | 3 | 并发实例上限，1–20 |
| `MAX_PAGES` | 10 | 每实例页面上限 |
| `ACTION_TIMEOUT_MS` | 15000 | 默认操作/导航超时，最高 60000 |
| `MAX_DOWNLOAD_BYTES` | 52428800 | 下载和单产物大小限制 |
| `MAX_DATA_BYTES` | 1073741824 | 产物存储配额，约 1 GiB |
| `ARTIFACT_RETENTION_HOURS` | 168 | 产物保留时间，默认 7 天 |
| `PROXY_CONFIG` | /config/proxies.json | 预配置代理文件 |
| `DATA_DIR` | /data（Docker） | 持久化产物、脱敏审计 |
| `MCP_SOCKET` | /tmp/browser-mcp/service.sock（Docker） | 容器内 Unix socket |
| `ALLOWED_HOSTS` | 空 | 目标主机白名单，逗号分隔，支持 `*.example.com` |
| `ALLOW_PRIVATE_NETWORKS` | false | 是否显式允许私网测试；会扩大访问范围 |
| `CHROMIUM_SANDBOX` | false | 启用 Chromium sandbox 需要宿主支持及适当 seccomp 配置 |

实例空闲默认 600 秒，最长生命周期默认 3600 秒，可创建时配置。空闲检测每 15 秒执行，进行中的操作不被空闲回收。单次 wait 最长 60 秒，下载最长 120 秒。

审计仅含工具名、principal、操作 ID、状态、错误码和耗时，不存参数、输入文本或代理密码。单个审计日志封顶约 5 MiB，达到上限后停止追加，下次启动轮换；产物按时间和总配额清理。活跃下载目录的大小限制是定期检查，瞬时使用可能超限，生产部署仍应设置磁盘配额。

## 8. 故障与边界

- 工具执行成功不等于业务通过。HTTP 200、点击完成都需要结合实际页面判断。
- 工具超时后先查看页面和 `list_operations` / `get_operation`，不要重复提交。状态仅保留管理进程最近 500 次调用，重启会丢失。
- 浏览器进程崩溃后需重建实例；重启容器不恢复登录态或活实例，数据卷内产物保留。
- 默认阻止私有/保留 IP、非 HTTP(S) URL，并检查每个请求。直连 DNS 在内部网关再次验证。
- **代理端 DNS 解析及任意上游代理行为不能由本服务完整约束**；仅使用可信代理和授权站点。面对恶意网站或严格出口隔离，应在容器/宿主网络层限制目标及非代理流量。浏览器 flags 和应用层校验不等于防火墙。
- 当前未覆盖 WebSocket 消息诊断、视频录制、持久化登录态、真机、验证码处理、内置国家库、定时 Agent 或多租户强隔离。
- non-root 运行不等于 Chromium sandbox 已启用。测试不可信网站前配置官方 Playwright 推荐的 sandbox/seccomp；不要用本服务替代浏览器安全边界。

## 9. 开发与验证

```sh
npm ci
npx playwright install chromium
npm run build
npm test
```

本地终端 A：

```sh
DATA_DIR=./data MCP_SOCKET=/tmp/browser-mcp-dev.sock node dist/cli.js daemon
```

终端 B：

```sh
MCP_SOCKET=/tmp/browser-mcp-dev.sock npm run smoke
```

容器运行后：

```sh
npm run smoke -- --docker
```

自动测试使用受控本地页面、HTTP 鉴权代理和 SOCKS5 鉴权代理，覆盖设备、隔离、交互、iframe、弹窗、下载、上传、产物归属，以及错误代理不回退直连。测试显式允许本地网络，生产默认不允许。

Playwright npm 版本与 Docker 基础镜像必须同步升级，否则可能找不到匹配浏览器。基础资料：[Playwright Docker](https://playwright.dev/docs/docker)、[设备模拟](https://playwright.dev/docs/emulation)、[MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/server)、[proxy-chain](https://github.com/apify/proxy-chain)。
