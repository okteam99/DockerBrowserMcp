# MCP 接口 V0.2

推荐使用 `BASE_URL/mcp` 的 Streamable HTTP，携带 `Authorization: Bearer <登录网页自动生成的 Token>`。网页登录后可复制完整配置。兼容 MCP stdio，通过 SSH 或 docker exec 接入。HTTP 调用共享 web principal，stdio 仍按 MCP_PRINCIPAL 隔离。

全部参数和默认值见 [机器可读 Schema](mcp-tools.json)，可通过标准 MCP `tools/list` 实时发现。以下展示工具 arguments，不是 HTTP 请求。

## 返回值

```json
{
  "operation_id": "uuid",
  "status": "succeeded",
  "data": {},
  "error": null
}
```

失败为 `status: failed`，包含 `error.code/message`，MCP `isError: true`。传输错误可能返回 `status: unknown` 和 operation_id；此时先 `get_operation`，断连未拿到 ID 时用 `list_operations` 查询。MCP Schema 参数不合法也可能直接返回协议级校验错误。

## 实例、环境与代理

| 工具 | 输入 | 输出要点 |
| --- | --- | --- |
| `list_recordings` | 可选 instance_id | 当前 principal 的录像、状态、playback_url；播放仍需网页登录或相同 Bearer |
| `health` | `{}` | 服务状态与容量 |
| `list_proxies` | `{}` | proxy_ref、server、country、鉴权标记，不返回密码 |
| `check_proxy` | proxy 或 proxy_ref；可选 check_url | 临时浏览器查询出口，始终清理；不能混用两种代理参数 |
| `create_instance` | UA、viewport、proxy/proxy_ref、mobile、locale、timezone、生命周期 | instance_id、pages、实际设备属性、警告 |
| `get_instance` | instance_id | 配置和页面，隐藏凭据 |
| `list_instances` | `{}` | 同 principal 的实例 |
| `verify_environment` | instance_id；可选 check_url | 实际设备属性、IP 查询响应；不自动判断国家 |
| `close_instance` | instance_id | 关闭状态，关闭后 ID 不再可用 |
| `list_operations` | limit 默认20，最多100 | 同 principal 最近操作的 ID、工具、时间与状态 |
| `get_operation` | operation_id | 最近调用的结果，或 running；仅当前 principal 可查 |

创建示例：

```json
{
  "user_agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  "viewport": {"width": 412, "height": 915},
  "mobile": {"enabled": true, "touch": true, "device_scale_factor": 2},
  "proxy_ref": "us",
  "idle_timeout_seconds": 600,
  "max_lifetime_seconds": 3600
}
```

## 页面与定位

| 工具 | 输入 |
| --- | --- |
| `create_page` | instance_id，可选 url |
| `list_pages` | instance_id |
| `close_page` | instance_id、page_id |
| `navigate` | instance_id、page_id、action（goto/reload/back/forward）；goto 必须 url |
| `snapshot` | instance_id、page_id；可选 frame CSS、limit（默认80，最多200） |
| `interact` | instance_id、page_id、action、target；按 action 传 value/checked/delta_x/delta_y |
| `wait_for` | instance_id、page_id；target/url/download_id 三选一；可选 timeout_ms（最多60000） |
| `handle_dialog` | instance_id、page_id、accept；可选 text |

`target` 必须且只能指定 ref、role、text、css 中一个；role 可搭配 name，frame CSS 可定位 iframe：

```json
{"role": "button", "name": "Search"}
```

```json
{"css": "input[name=q]", "frame": "iframe#search"}
```

```json
{"ref": "g1e3"}
```

role/name 和 text 为精确匹配。多元素匹配会报错，不默认点击第一个。快照 ref 绑定原始 DOM 节点，不会因列表重排而指向另一节点。导航或交互后主动失效；DOM 变化后应重新取快照，节点移除会导致操作失败。

交互示例：

```json
{"instance_id":"ins_...","page_id":"page_...","action":"fill","target":{"css":"input[name=q]"},"value":"example"}
```

```json
{"instance_id":"ins_...","page_id":"page_...","action":"click","target":{"role":"button","name":"Search"}}
```

支持 click、fill、press（如 Enter）、select（原生 select option value）、check、hover、scroll。scroll 无 target 时滚动页面；有 target 时先滚动元素到视口，再滚动页面。interact 返回当时的页面列表，延迟弹窗需另查 list_pages。操作触发 JavaScript 对话框时返回 pending_dialog，先用 handle_dialog 处理，再检查最终结果；此时点击已发出，但流程尚未完成。

`wait_for` 的 state 为 visible/hidden/attached/detached。url 支持 Playwright URL glob。download_id 必须是 list_downloads 已返回的 ID。

## 诊断与产物

| 工具 | 输入 | 输出 |
| --- | --- | --- |
| `get_diagnostics` | instance_id，limit 默认100，最多300 | 脱敏响应状态/跳转/失败请求、console 类别、下载 |
| `screenshot` | instance_id、page_id、full_page 默认false | PNG artifact 元信息 |
| `list_downloads` | instance_id | 下载状态、失败、完成后的 artifact |
| `put_artifact` | name、data_base64，可选 mime | 保存授权文件，解码后最多512 KiB |
| `upload_file` | instance_id、page_id、target、artifact_id | 将已有文件上传到 file input |
| `get_artifact` | artifact_id，offset 默认0，length 默认262144/最多524288 | base64、sha256、size、next_offset、complete |

artifact_id 不接受任意文件路径。get_artifact 按 next_offset 继续读取，客户端拼接解码后的字节并与 sha256 比较。完整返回 PNG 时会附带 MCP image 内容。上传和下载在 close_instance 后仍可读取，直到过期或配额清理。

诊断移除 URL 查询参数，不记录 console 原始字符串或响应正文，降低凭据泄漏风险；页面快照、最终 URL、截图和下载文件仍可能含敏感业务数据。

## 错误与并发

- INVALID_ARGUMENT / INVALID_TARGET / INVALID_URL
- INSTANCE_LIMIT / INSTANCE_NOT_FOUND / INSTANCE_BUSY
- PAGE_LIMIT / PAGE_NOT_FOUND
- NETWORK_BLOCKED / PROXY_NOT_FOUND / PROXY_CONNECTION_FAILED
- ENVIRONMENT_CHECK_FAILED / TIMEOUT / BROWSER_CLOSED
- STALE_ELEMENT_REFERENCE / AMBIGUOUS_ELEMENT / ELEMENT_ERROR
- DOWNLOAD_FAILED / DOWNLOAD_TOO_LARGE / DOWNLOAD_NOT_FOUND
- ARTIFACT_NOT_FOUND / ARTIFACT_TOO_LARGE / STORAGE_LIMIT
- DIALOG_NOT_FOUND / OPERATION_NOT_FOUND / OPERATION_FAILED

同实例一次只允许一个执行中的操作，其他实例可并行。close_instance 可强制结束正在运行的操作。get_operation 可查询当前管理进程最近500个调用；不能当作跨进程重启的永久幂等机制。服务不会自动重试点击或提交。

当前不支持外部 cancel 操作；可通过 close_instance 中止该实例。工具最长单步等待受配置限制，MCP 接入等待管理进程最多180秒，超时后原操作可能仍运行，需检查状态。

## 管理与媒体 HTTP 路由

所有地址均相对于 BASE_URL。`/` 为密码登录及说明/监看页；`POST /login`、`POST /logout` 管理 Cookie 会话。`GET /healthz` 仅返回无敏感信息的存活状态。

以下路由均需要登录 Cookie 或相同 Bearer Token：

- `GET /api/connection`：自动生成的 MCP URL、JSON 配置、完整 Agent 接入说明。
- `GET /api/instances`：管理员可查看全部活跃实例及容量。
- `GET /api/instances/{instance_id}/live`：MJPEG 低帧率直播。
- `GET /api/recordings`：历史录像。
- `GET /api/recordings/{recording_id}/video`：WebM 播放/下载，支持 Range；录像未完成返回 409。
- `GET /docs/README.md`、`/docs/mcp-api.md`、`/docs/mcp-tools.json`、`/docs/agent-workflow.md`：完整文档。

`POST /mcp` 只接受 Bearer 鉴权，不使用 Cookie。密码变更并重启后 Token 轮换；不把 Token 放在 URL 中。直播和录屏包含可见业务内容，请仅授权可信使用方。
