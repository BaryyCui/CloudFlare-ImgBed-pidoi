# Docker 图床定时清理

基于 c80e236，为现有 Docker + SQLite + 本地 R2 运行方式增加管理员可配置的保留期清理。当前请求是增加功能；本次不部署、不启用生产定时删除。

## 使用规则

- 默认关闭。默认保留 7 天，每日 Asia/Shanghai 03:00 执行。
- 首版范围固定为本地 R2 的 videos/ 及子目录，包含图片、视频和音频。不是按 MIME 仅清理视频；不触碰其他目录或远端 S3/Telegram/Cloudflare 存储。
- 按有效上传时间和文件落盘时间双重判断，两者均须严格早于本次固定截止时刻。文件在预览/扫描后变化、活动写入、符号链接、异常时间、临时分片均跳过。
- 管理员可配置开关、保留天数、每日时间，查看预计清理数量/容量和样例，并通过明确确认手动运行。
- 保存配置不等于立即执行。启用后首次计划为下一个每日时刻；服务重启可补执行已到期的单次计划，不循环补删多天。

## 结构

1. Docker 本地 retention 服务独立模块，注入环境能力。非 Docker API 返回明确不支持。
2. SQLite 持久运行状态和跨实例租约，定时/手动共用执行器；固定配置与截止时间，每次最多一个任务。完成、部分失败、跳过、取消及进度可查询；重启恢复或标记中断，不静默遗失任务。
3. 数据删除必须绑定实际对象版本，复核元数据并保护活动写入。对象删除后再完成数据库记录、准确匹配的导入幂等记录、索引一致性处理。发生中断可完成收尾，不将新版本误当作旧对象删除。
4. 历史 add/batch_add/move 或正在执行的旧索引合并不能让已清理记录重新出现在管理列表。避免调用现有全局重建/清空操作。可使用持久删除屏障以及读取时权威校验；正常新一代文件不得被旧屏障隐藏。
5. 后台 /systemConfig#retention 新增原生设置 tab，复用官方前端固定版本源码、Vue/Element Plus 组件与现有图标。前端源码保留在本仓库，统一构建 frontend-dist，不直接手改压缩 bundle。

## API 合约

环境能力名 RETENTION_SERVICE，缺失时 supported=false。

- GET /api/manage/sysConfig/retention -> {supported, config, nextRunAt, activeRun, recentRuns, disk}
- POST /api/manage/sysConfig/retention，body {enabled, retentionDays, runAt} -> 同 GET
- POST /api/manage/retention/preview，使用已保存配置 -> {previewToken, cutoff, expiresAt, count, bytes, samples, skipped}
- POST /api/manage/retention/run，body {previewToken, confirmation:"DELETE_EXPIRED_FILES"} -> 202 {run}
- GET /api/manage/retention/status?id=<optional run id> -> status 或 {run}
- 所有接口需要管理员 session 或 manage 权限 token；修改接口检查同源 Origin，并只接受 JSON。无管理凭据配置时禁止自动清理功能启用/手动执行。
- 配置 {enabled:false, retentionDays:7, runAt:"03:00", timezone:"Asia/Shanghai", folder:"videos"}。保留天数整数 1..3650；时间严格 HH:mm。
- 服务接口 getStatus(), saveConfig(input), preview(), startManual(input), getRun(id), start(), close()。方法可 async。createRetentionService({database, storage, dataDir, now})：database 为 SqliteD1.db 原生连接，storage 为 LocalR2Storage；now 可注入测试时钟，默认 Date.now。

## 验证

临时 SQLite + 临时素材目录测试真实删除、严格时间边界、目录隔离、无副作用预览、权限与确认、两执行器竞争、重启、活动/替换文件、失败重试收尾、导入重放和历史索引操作。前端验证保存失败反馈、预览和确认、运行状态、日志与窄屏布局。现有 79 项转存回归需保持通过。
