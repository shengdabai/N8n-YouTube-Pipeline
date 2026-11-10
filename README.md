# n8n YouTube Pipeline

> **n8n 必需设置（工作流 3「分镜视频生成与自动粗剪」）**
> - `VIDEO_CDN_HOSTS`：视频下载主机白名单，逗号分隔的精确主机名（例如 `media.example.com,cdn2.example.com`），不支持通配符。可选：未设置时接受任意公网 HTTPS 主机（仍拒绝 IP 地址、非 443 端口、带账号密码的链接，并固定到已校验的公网 IP）；设置后只接受列出的主机。
> - `NODE_FUNCTION_ALLOW_BUILTIN=dns,fs,https,net,url`：Code 节点需要这些内置模块。
> - 若 n8n 屏蔽了 Code 节点读取环境变量，需设置 `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`。
> - 下载仅允许 HTTPS、标准端口、无重定向，且主机解析到公网 IPv4。

n8n 自动化工作流 — YouTube 视频采集、分镜拆解与 AI 内容生成。

## 工作流列表

### 1. YouTube对标频道爆款视频采集
自动采集对标频道的热门视频数据，分析爆款特征。

### 2. 视频分镜拆解与AI图片生成
将视频拆解为分镜描述，并调用 AI 生成对应图片。

### 3. 分镜视频生成与自动粗剪
基于分镜图片自动生成视频，并完成初步剪辑。

## 技术栈
- n8n 自动化平台
- AI 视频/图片生成 API

## 使用方法
1. 将 `.json` 工作流文件导入 n8n
2. 配置相应的 API 凭证（环境变量）
3. 激活工作流并触发执行
