# URL 素材导入

`POST /api/import-url` 使用与上传接口相同的 `upload` 权限。图床服务下载来源并转存到已经配置、启用的 R2 或 S3 渠道，适合图片、视频和音频素材。请求鉴权沿用现有 API Token 或 `authCode`；不要把图床鉴权信息放进来源 URL。

## 请求与返回

```json
{
  "url": "https://media.example.com:40000/asset",
  "mediaType": "auto",
  "mode": "stream",
  "uploadChannel": "s3",
  "channelName": "materials",
  "uploadFolder": "references",
  "maxSizeMB": 512,
  "idempotencyKey": "request-123-asset-1"
}
```

- `mediaType` 为 `auto`、`image`、`video` 或 `audio`。省略相当于 `auto`；按文件签名识别，不按 URL 后缀猜测。指定类别与识别结果不符会失败。支持常见 PNG/JPEG/GIF/WebP/AVIF/HEIC、MP4/WebM/Ogg、MP3/AAC/WAV/FLAC 等签名；HTML、SVG、未知格式不会作为素材上传。
- `contentType`、`filename` 可选；`contentType` 不能绕过文件签名检查。WebM 等音视频共用容器会结合声明的 MIME 判断类别。
- `uploadChannel` 支持 `cfr2`（默认）或 `s3`。`channelName` 指定已经配置的渠道；不存在、已停用或不可用时失败。未指定名称时固定选择该存储类型的第一个可用渠道。导入或重试期间不会改用其他渠道。
- `uploadFolder` 默认 `videos`，保留旧客户端行为。文件名和文件夹会经过既有路径清理。
- `maxSizeMB` 限制本次素材大小，不能超过服务端上限；省略或 `0` 使用服务端上限。没有 Content-Length 时仍逐块限制实际字节数。
- `idempotencyKey` 可选，长度 1–256。相同 key、完整来源 URL、目的存储身份和相关导入选项生成相同的安全哈希文件名。完成后再次请求直接重放结果，并重新检查本次大小限制；来源或目的存储改变则生成不同文件。记录不保存来源 URL 或鉴权头。跨实例并发请求不提供事务锁，但使用同一确定对象键，不创建随机重复文件。

指定 `mode: "stream"`，或请求头 `Accept: application/x-ndjson`，成功进入导入后返回 `Content-Type: application/x-ndjson`，每行一个 JSON 对象：

```json
{"state":"downloading","attempt":1,"bytes_done":0}
{"state":"uploading","attempt":1,"bytes_done":8388608,"bytes_total":12582912,"mediaType":"video"}
{"state":"completed","attempt":1,"bytes_done":12582912,"bytes_total":12582912,"mediaType":"video","src":"/file/references/import-example.mp4","publicUrl":"https://cdn.example.com/file/references/import-example.mp4"}
```

`bytes_total` 只在已知且未超限时出现；`bytes_done` 是已接收并计入本次大小限制的字节数，超限部分会丢弃。`attempt` 是本次导入的来源请求或分片上传的最高尝试次数。进度在分片前后发送，处理中每 5 秒补一条；客户端应持续读取流。

**只有最后的 `completed` 表示成功**，此时对象、元数据和索引操作均已保存。`failed` 为终止事件，提供安全的 `error` 和 `code`，例如 `size_limit`、`media_mismatch`、`blocked_source`、`stalled`、`timeout`。HTTP 200、连接结束或收到 `uploading` 都不代表成功。鉴权、参数和存储选择错误在开始流之前返回相应 HTTP 错误及 JSON。

未请求 NDJSON 的旧调用仍返回 JSON 数组 `[{"src":"/file/...","publicUrl":"..."}]`。仅配置了 `urlPrefix` 才返回 `publicUrl`，不会从请求域名推断公开域名。

## 传输、安全与部署

下载与上传使用固定 8 MiB 分片，无需把完整对象读入内存。R2 使用 multipart binding，S3 使用已有 AWS SDK multipart 接口；Docker 的本地 R2 适配器把分片和合并结果流式写入磁盘，再原子发布。

- 默认上限 2 GiB、总耗时 5 分钟、单次无进度等待 30 秒。可通过 `IMPORT_URL_MAX_BYTES`、`IMPORT_URL_TIMEOUT_MS`、`IMPORT_URL_IDLE_TIMEOUT_MS` 设置正整数，时间单位为毫秒。
- 来源 HTTP 408/429/500/502/503/504、部分瞬时网络错误和可重试分片错误最多尝试 3 次，间隔 100/200 ms。分片重试复用当前有界缓冲区，不重复下载整文件；不对不确定的 complete 操作盲目重试。
- 断连、超时和失败会取消来源流并尝试 abort 尚未完成的 multipart。建议在对象存储配置未完成 multipart 生命周期清理，以覆盖进程退出或网络断开后的清理失败。
- 若对象已经明确完成提交，断连后仍用独立的最长 5 秒保存元数据、索引和幂等结果，并以 `waitUntil` 保护这段必要收尾；取消的响应不会因此变成成功。若存储服务在完成提交后丢失应答，或收尾本身失败，可能遗留需要检查的对象。接口会失败，且不会冒险删除可能由并发幂等请求完成的同名对象。
- 来源仅允许公网 HTTP/HTTPS；拒绝 URL 用户信息、本地/私有/保留 IP 和 DNS 中的任何非公网地址。最多跟随 5 次重定向，逐跳重新校验。Docker 对解析结果固定拨号；Workers 先校验公网 DNS 的 A/AAAA 结果，再使用平台公网 fetch，无法像 Node 一样指定最终 socket 地址。
- 用户素材无需 `headers`。旧视频导入的 Authorization/Cookie 仅在原来源 origin 内使用；一旦跨 origin 永久移除，不转发 Proxy-Authorization，也不复制图床请求鉴权。
- 公网 `39999`、`40000` 等自定义端口在 Docker 可用。Worker 配置和配置生成器均包含 `allow_custom_ports`；Cloudflare 代理域名仍受其代理支持端口限制，非标准端口来源应使用可直接访问的 DNS-only 域名和开放的防火墙规则。
- Worker 部署需绑定数据库和所选 R2/S3 配置，先运行 `node deploy/worker/generate-routes.js`。Docker 需更新 Node 服务与本地存储适配器。反向代理需允许 NDJSON 持续返回，避免响应缓冲，并设置覆盖总超时的读取时限。

这是保持响应连接的导入接口，不返回 202 后把大型转存丢给 `waitUntil`。进程中断后，调用方可使用同一幂等键重新请求。
