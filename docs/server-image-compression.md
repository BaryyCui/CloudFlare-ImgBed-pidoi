# 服务端图片压缩

Docker 图床在「系统设置 → 上传设置 → 服务端图片压缩」提供独立配置。它与网页上传前的浏览器压缩设置分开，API 调用无需添加参数。

默认关闭；压缩阈值默认 5 MB，目标大小默认 4 MB。这里 1 MB 按 1,048,576 字节计算。阈值可设 1–20 MB，目标可设 0.5 MB 至阈值之间，允许小数。点击保存后，新请求读取最新设置；旧文件不会重新压缩。

## 覆盖范围

- `POST /upload` 普通表单上传：在选择存储渠道写入前处理图片，支持本地 R2、远程 S3 及其他普通上传渠道。网页通过同一接口上传时也生效。
- `POST /api/import-url` URL 转存：按真实文件签名识别图片，再按同一策略处理；公网来源校验、超时、大小限制、来源鉴权及幂等行为保留。
- R2/S3 分块上传：合并完成后、文件记录对外发布前压缩。远程 S3 会增加一次读取和覆盖写入。
- Telegram/Discord 的分片清单、HuggingFace 绕过服务端的直传不会重新组合处理。

## 图片处理

仅处理超过阈值的静态 JPEG、PNG、WebP、AVIF。保留原格式、透明通道及显示方向，先尝试编码优化，再按比例缩小尺寸；PNG 不改成 WebP。目标大小是尽力达到的目标，不是拒绝上传的上限；最短边不会主动缩小到 128 像素以下。

GIF、APNG、动态 WebP/AVIF、SVG、HEIC、视频、音频保持原样。单张源图超过 64 MiB 或 4000 万像素也保持原样。解码失败、压缩超时、无体积收益或压缩器繁忙时保存原图。原图必须仍满足已有上传和来源限制；下载失败、来源被禁止、来源截断、请求取消不会被压缩回退掩盖。

压缩在 Docker 独立子进程中执行，每个服务进程最多一个压缩任务，并有 15 秒硬超时，避免并行解码大图耗尽资源；Pages/Workers 不支持此服务端压缩配置。上传接口原有 `serverCompress` 参数仍只控制 Telegram 的发送方式，不能覆盖这个管理员配置。

分块原文件已经合并成功后，客户端断连只取消可选压缩，仍会保存原文件记录；如果已经开始替换为压缩图，则使用独立的最长 30 秒写入预算完成替换和记录更新。

普通 API 上传应提供正确的图片 MIME，例如 `Content-Type: image/jpeg` 的文件字段。压缩后文件记录保存实际大小、尺寸，以及 `ImageCompression`（源字节数、保存字节数、目标字节数、是否达到目标）。原有响应的 `src`、`publicUrl` 结构不变。

## 管理 API

沿用现有管理员认证及 `GET/POST /api/manage/sysConfig/upload`。上传配置中新增：

```json
{
  "imageCompression": {
    "enabled": false,
    "thresholdMB": 5,
    "targetMB": 4
  }
}
```

GET 额外返回只读 `imageCompressionSupported` 能力标记。旧客户端保存渠道时若不携带 `imageCompression`，保留原设置；非法值或在不支持的运行环境开启时返回 HTTP 400，不覆盖已有配置。网页中的编辑草稿不会因切换其他渠道开关而被保存。

## 验证

```sh
node --import ./deploy/server/register.mjs --experimental-vm-modules ./node_modules/mocha/bin/mocha --exit --timeout 30000 test/image-compression-config.test.cjs test/import-image-compression.test.cjs test/upload-image-compressor.test.cjs test/upload-image-integration.test.cjs test/compression-multipart-finalization.test.cjs
cd frontend
npm test -- --reporter=dot
npm run build
```
