# DockerBrowserMcp

**让 AI 操作浏览器，实时直播、全程录屏，操作过程看得见。** 通过 MCP 将远程浏览器接入 AI Agent；打开控制台、输入访问密码，即可复制完整接入说明。

实例创建时可指定 UA、页面视口、HTTP/SOCKS5 鉴权代理、语言与时区；支持点击、输入、iframe、多标签页、上传下载、截图及诊断。

## 快速部署

以下命令使用已发布的实际镜像版本。先将 `WEB_PASSWORD` 改为自己的密码；本地部署后访问 `http://localhost:8080`。部署到远程服务器时，将 `BASE_URL` 改为实际访问地址：

```sh
docker run -d --init \
  --name docker-browser-mcp \
  --restart unless-stopped \
  --shm-size=1g \
  -p 8080:8080 \
  -e BASE_URL=http://localhost:8080 \
  -e WEB_PASSWORD='替换为你的强密码' \
  -e MAX_INSTANCES=10 \
  -v browser-mcp-data:/data \
  bdpgogoup/dockerbrowsermcp:20261020203319
```

`BASE_URL` 是用户或 Agent 实际访问的外网地址；由部署方确保 DNS、反向代理、HTTPS 或端口映射已接通容器 8080。服务不会自动申请证书或创建隧道。本机试用可用 `BASE_URL=http://localhost:8080`。

### 使用步骤

1. 打开 `BASE_URL`，输入 `WEB_PASSWORD`。
2. 点击 **复制完整 Agent 接入说明**，粘贴给 Agent。也可单独复制 MCP JSON 配置。
3. Agent 配置远程 MCP 后，先调用 `health`，再创建和控制浏览器实例。
4. 在网页“实时实例”中选择实例观看直播；关闭实例后，在“历史录屏”播放录像。

控制台使用 React + Ant Design，包含工作台、实时实例、历史录屏、MCP 接入和文档中心，并适配手机屏幕。所有前端资源随镜像打包，不依赖外部 CDN。

不需要 SSH 配置或 Chrome 插件。原 stdio / SSH 接入方式仍保留。

## MCP 地址与鉴权

- 地址：`BASE_URL/mcp`
- 协议：**Streamable HTTP**，不是旧 SSE。
- 鉴权：`Authorization: Bearer <自动生成的 Token>`。
- Token 在第一次部署时生成并保存到数据卷。密码与 Token 分开，Token 不在 URL 查询参数中。
- 同一数据卷、同一密码重启后 Token 保持不变；更换 `WEB_PASSWORD` 并重启会轮换 Token，使旧配置失效。
- 登录 Cookie 为 HttpOnly、SameSite=Strict，默认有效 24 小时；服务重启后需重新登录。

登录页可获取的通用配置示例：

```json
{
  "mcpServers": {
    "docker-browser": {
      "type": "http",
      "url": "https://browser.example.com/mcp",
      "headers": { "Authorization": "Bearer <网页自动生成>" }
    }
  }
}
```

Agent 必须支持远程 Streamable HTTP MCP 及自定义 Authorization 请求头。不同客户端的配置文件格式可能不同；网页提供服务地址、请求头、通用 JSON 和完整接口说明供 Agent 适配。

本版本是单管理员服务。网页可以查看全部实例；HTTP MCP 调用共享 `web` principal。Token 可控制浏览器并读取录像，请只交给可信 Agent。外网部署使用 HTTPS，避免密码、Token 与浏览器内容以明文传输。

## 创建指定环境

`create_instance` arguments 示例：

```json
{
  "user_agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  "viewport": { "width": 412, "height": 915 },
  "mobile": { "enabled": true, "touch": true, "device_scale_factor": 2 },
  "locale": "en-US",
  "timezone": "America/New_York",
  "proxy": {
    "server": "socks5://proxy.example.com:1080",
    "username": "your-user",
    "password": "your-password"
  }
}
```

- 每个实例独立浏览器进程和会话；新标签页继承同一代理和设备环境。
- 支持 `http://`、`https://` 上游与 `socks5://`，凭据通过独立字段传入。
- 省略 proxy 是明确的直连模式；指定代理失败不会回退直连。
- 环境参数创建后固定，切换环境需新建实例。
- UA 示例仅展示配置，不代表当前真实浏览器版本。Client Hints、页面布局和真机可能不同。
- viewport 是 CSS 像素的设备视口；移动页面没有 viewport meta 时，layout_viewport 可能约为 980px。
- 返回 instance_id、初始 page_id 和实际设备属性。用 `verify_environment` 验证出口，不把配置的国家标签当作真实地区。

`verify_environment` 默认访问第三方 `https://api.ipify.org?format=json`，可传自己的 `check_url`。地区数据库未内置。

## 直播和录像

默认参数：

| 项目 | 默认 |
| --- | --- |
| 采样帧率 | 2 FPS |
| 最大画面 | 640 × 480，保留比例，录像留黑边 |
| JPEG 质量 | 40 |
| 录像 | VP9 WebM，无音频 |
| 单实例录像上限 | 128 MiB |
| 历史录像总配额 | 1 GiB |
| 保留时间 | 7 天 |

直播使用 MJPEG，多个观看者共享同一份实例采样，不重复启动浏览器或截图任务。实例内新页面和最近操作的页面成为活动页面，直播和录像随之切换；不会同时录制所有标签页。

历史录像支持浏览器播放和 Range 请求。正常关闭实例会完成录像；异常终止会标记为 interrupted，残留文件不保证完整可播。达到单段大小上限后停止录像，直播仍可继续。采样或编码拥塞时可能丢帧，录像时长可能短于真实执行时长；这是低负载过程留证，不是精确时间审计。

录像会包含浏览器中可见的输入与业务内容。通过 `RECORD_VIDEO=false` 可关闭历史录像，实时预览仍可用。产物和录像保存在 `/data`，需挂载数据卷。

## 并发与运行配置

**默认最多 10 个并发浏览器实例**，超过直接返回 `INSTANCE_LIMIT`，不无限排队。可通过 `-e MAX_INSTANCES=5` 等修改。上限不是预分配数量，建议先在实际网站上测量内存；10 个实例应预留相应服务器资源。

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `BASE_URL` | 必填 | 外网访问根地址，可包含路径前缀，如 https://host/browser |
| `WEB_PASSWORD` | 必填 | 网页访问密码，不写入普通日志 |
| `WEB_PORT` | 8080 | 容器 HTTP 端口；设为 0 可用纯 stdio 模式 |
| `MAX_INSTANCES` | 10 | 最大并发实例数，1–100 |
| `MAX_PAGES` | 10 | 每实例最大页面数 |
| `ACTION_TIMEOUT_MS` | 15000 | 默认工具/导航超时 |
| `RECORD_VIDEO` | true | 是否保存历史录像 |
| `VIDEO_FPS` | 2 | 1–10 FPS |
| `VIDEO_WIDTH` / `VIDEO_HEIGHT` | 640 / 480 | 低清视频画面边界，建议使用偶数值 |
| `VIDEO_QUALITY` | 40 | JPEG 质量，10–80 |
| `FFMPEG_PATH` | ffmpeg | 编码程序路径；Docker 内已安装 |
| `MAX_RECORDING_BYTES` | 134217728 | 单段录像大小上限 |
| `MAX_RECORDINGS_BYTES` | 1073741824 | 历史录像总配额 |
| `MAX_DOWNLOAD_BYTES` | 52428800 | 下载及单产物大小限制 |
| `MAX_DATA_BYTES` | 1073741824 | 截图/下载等产物配额，不含录像 |
| `ARTIFACT_RETENTION_HOURS` | 168 | 产物及历史录像保留时间 |
| `PROXY_CONFIG` | /config/proxies.json | 预配置代理文件 |
| `DATA_DIR` | /data（Docker） | 数据存储位置 |
| `ALLOWED_HOSTS` | 空 | 可选目标白名单，逗号分隔，支持 *.example.com |
| `ALLOW_PRIVATE_NETWORKS` | false | 显式允许内网测试，会扩大访问范围 |
| `CHROMIUM_SANDBOX` | false | 是否启用 Chromium sandbox，需宿主配套配置 |

密码或 BASE_URL 缺失时，Web 模式启动失败，不会开放无密码管理页。BASE_URL 仅用于外部地址、来源校验与 Cookie 设置，不能替代实际网络配置。

对于路径前缀，反向代理可保留或剥离该前缀，页面链接均使用配置的外部前缀。反向代理需保留客户端 Origin，且直播路由禁用缓冲（Nginx 可设 `proxy_buffering off`），MCP 路由需允许 POST 并配置足够超时。

## 使用预配置代理（可选）

复制 `config/proxies.example.json` 为自己的配置文件；真实文件已被 .gitignore 排除。启动时添加只读挂载：

```sh
--mount type=bind,src=/srv/browser-mcp/proxies.json,dst=/config/proxies.json,readonly
```

Agent 用 `list_proxies` 获取名称，再传 `proxy_ref` 创建实例。`proxy` 和 `proxy_ref` 互斥。文件需可被容器非 root 用户读取；修改配置后新实例生效，已有实例不变。

## 上传下载、诊断与操作状态

- 下载自动捕获：`list_downloads` → `wait_for` → `get_artifact` 分块获取并校验 SHA-256。
- 上传：`put_artifact` 接收授权文件的 base64（最多 512 KiB），`upload_file` 上传到 file input；不接受任意宿主路径。
- `snapshot` 返回页面结构和原始 DOM 节点引用，页面变化后重新读取。
- `get_diagnostics` 查询脱敏跳转和请求失败，`screenshot` 保存截图。
- 超时或断连后用 `list_operations` / `get_operation` 确认状态，不盲目重复提交。
- `list_recordings` 返回当前 principal 的历史录像及带路径的 playback_url，获取时仍需 Bearer 鉴权。

工具执行成功不等于业务流程通过；实际测试标准由 Skill 决定。

## 发布镜像

发布目标固定为 **Docker Hub `bdpgogoup/dockerbrowsermcp`**。标签为 `YYYYMMDDHHMMSS`，默认上海时区。脚本默认构建并推送 amd64 / arm64 两个平台，不发布 latest 别名。

```sh
# 先预览，不构建、不登录、不推送
bash scripts/publish-docker.sh --dry-run
# 使用本机已登录 bdpgogoup 的 Docker 凭据发布
docker login --username bdpgogoup
bash scripts/publish-docker.sh
```

可通过 `DOCKERHUB_TOKEN` 环境变量让脚本自动以 bdpgogoup 登录，Token 使用 password-stdin，不打印。支持 `PLATFORMS`、`RELEASE_TZ` 和 `RELEASE_TAG`（14位时间标签）覆盖。脚本依赖 Docker Buildx；不在代码或镜像中保存账号密码。发布时自动将 README 部署示例更新为本次实际 tag，成功后输出镜像名和可复制的分行部署命令；发布失败时恢复原 tag。

## 源码构建及 stdio 接入

```sh
docker build -t docker-browser-mcp:0.3.1 .
```

将一行部署命令最后的镜像名换成 `docker-browser-mcp:0.3.1` 即可本地使用。

兼容配置见 [本地 stdio](examples/mcp.local.json)、[SSH stdio](examples/mcp.ssh.json)。仍使用 `docker exec -i`，不得使用 `-t`。MCP_PRINCIPAL 是可信 SSH/Docker 接入中的命名空间，不是独立认证。

## 开发与验证

前端源码位于 `web/`，使用 React + Ant Design。`npm run build` 同时进行类型检查、构建服务端和打包前端（含 gzip 资源）；Docker 镜像只需运行编译产物。

需要 Node.js 22+、FFmpeg，以及 Playwright Chromium：

```sh
npm ci
npx playwright install --with-deps chromium
npm run format:check
npm test
npm run schema
```

本地纯 stdio：

```sh
WEB_PORT=0 DATA_DIR=./data MCP_SOCKET=/tmp/browser-mcp-dev.sock node dist/cli.js daemon
```

另一个终端：

```sh
MCP_SOCKET=/tmp/browser-mcp-dev.sock npm run smoke
```

容器验证：`npm run smoke -- --docker`。HTTP、直播和录屏验证：`SMOKE_BASE_URL=http://localhost:8080 SMOKE_PASSWORD=你的测试密码 npm run smoke:http`。可选 `SMOKE_URL` 做实际导航验证。

## 访问边界

默认阻止私有/保留 IP、非 HTTP(S) 目标，网关检查请求和直连 DNS。可信上游代理的远端 DNS 行为仍需信任；严格防旁路要求配置网络层防火墙。不要将应用层检查或浏览器 flags 当作完整隔离。

非 root 运行不代表 Chromium sandbox 已启用；测试不可信网站需配置 sandbox/seccomp。不会自动安装应用、执行下载文件、绕过验证码或启动定时 Agent。定时任务由独立 Agent 调度器负责。

文档：[MCP 接口](docs/mcp-api.md) · [工具 Schema](docs/mcp-tools.json) · [Agent 流程](docs/agent-workflow.md) · [验证记录](docs/validation.md)。[V1 需求草案](docs/requirements-v1.md) 为历史设计，以当前文档与实现为准。
