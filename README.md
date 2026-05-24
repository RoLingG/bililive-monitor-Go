# bililive-monitor-Go

![Go](https://img.shields.io/badge/Go-%3E%3D1.23-00ADD8.svg) ![Wails](https://img.shields.io/badge/Wails-2.0+-C70039.svg) ![Frontend](https://img.shields.io/badge/Frontend-Vanilla_JS-F7DF1E.svg) ![Vite](https://img.shields.io/badge/Vite-3.0+-646CFF.svg)

B站直播间付费内容监听桌面应用，基于 Wails v2 (Go + Web Frontend) 构建。

为主播提供醒目留言、上舰、礼物的实时追踪与展示，弥补现有直播辅助软件在付费内容可视化方面的不足。

## 功能

### 醒目留言 (SC)
- 实时监听并展示 SC 内容：头像、用户名、勋章、舰长等级、价格、留言消息
- 列表自动滚动，保留最近 200 条
- 头像通过本地代理请求，自动绕过 B站 CDN 防盗链

### 上舰通知
- 监听总督 / 提督 / 舰长购买事件
- 紧凑卡片样式，显示舰长类型、用户名、价格

### 礼物追踪
- 监听付费礼物（自动过滤免费银瓜子礼物）
- 连击合并：同一用户短时间内连续赠送同种礼物，自动合并显示为 `×N`
- 连击检测支持 B站 `BatchComboId`，缺失时自动 fallback 到 `uid + giftId` 五秒窗口合并

### 连接状态
- 左上角实时显示连接状态：已连接 / 重连中 / 连接失败 / 未连接
- 基于 B站高频广播事件（`WATCHED_CHANGE`、`ONLINE_RANK_COUNT`、`ROOM_REAL_TIME_MESSAGE_UPDATE`）的心跳检测
- 120 秒无活动自动标记为断连，blivedm-go 库的客户端连接会自动重连

### 点播模式
- 筛选仅展示包含 BV 号的醒目留言
- BV 号自动转为可点击链接，跳转 B站视频页面
- 切换模式时数据互不丢失，两套数据各自保留在内存中
- 模式切换带动画过渡

### 配置记忆
- 直播间号和 Cookie 自动保存到 `localStorage`，下次打开应用自动恢复

### 数据导入/导出
- 支持将醒目留言、上舰、礼物数据导出为 JSON 文件
- 支持从 JSON 文件导入历史数据，自动去重合并
- 适用于软件重启、电脑故障等场景下的数据恢复

## TODO
- 目前有相关需求想要集合点歌功能（奈何本人没做过，如果有相关经验的人员看到想助力可以直接提PR，会进行审查）
- 相关Bug修复（如使用有发现相关bug，可以直接提Issue，本人看到会及时处理）

## 项目结构
```
lutou/
├── app.go              # Go 后端：WebSocket 事件处理、连击追踪、连接监控
├── main.go             # Wails 入口：窗口配置、头像代理中间件
├── frontend/
│   ├── index.html      # 页面结构：配置页 + 监听面板
│   ├── src/
│   │   ├── main.js     # 前端逻辑：事件监听、卡片渲染、模式管理、配置记忆
│   │   └── style.css   # 样式：前端样式
│   └── wailsjs/        # Wails 自动生成的 JS 绑定
└── wails.json          # Wails 项目配置
```

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | [Wails v2](https://wails.io/) |
| 后端 | Go + [blivedm-go v1.6.0](https://github.com/Akegarasu/blivedm-go) (B站直播 WebSocket) |
| 前端 | Vanilla JS + HTML + CSS（无框架） |
| 构建 | Vite (前端) + Go build (后端) |

## 开发

```bash
# 安装依赖
npm install

# 开发模式（热更新）
wails dev

# 构建生产版本
wails build
```

## 使用方法

1. 运行应用后在配置页输入**直播间号**和 **Cookie**
2. Cookie 从浏览器登录 B站 后，在开发者工具 → Network 面板 → 随便点一个请求 → 复制 `Cookie` 请求头的值
3. 点击"启动监听"进入监听面板
4. 可通过面板右上角的「正常 / 点播」按钮切换模式

## 致谢

本项目的核心依赖 [blivedm-go](https://github.com/Akegarasu/blivedm-go)，提供了 B站直播 WebSocket 协议的完整封装。没有这个库就没有这个项目，特别感谢作者 [Akegarasu](https://github.com/Akegarasu) 和 [blivedm-go](https://github.com/Akegarasu/blivedm-go) 相关贡献者的开源贡献。 同时也感谢 Mimo-v2.5-pro 模型鼎力协助本项目的开发。

## 免责声明

> **本项目为非官方工具，与哔哩哔哩 (Bilibili) 及其关联公司没有任何关联。所有直播数据、用户信息、礼物信息的版权归原作者所有。**

- 本软件按 **"现状"** 提供，不保证可用性、稳定性或数据准确性，使用过程中造成的任何数据损失、账号封禁、功能异常或经济损失，均由用户自行承担。
- 本软件仅供 **个人学习与研究** 使用，不承担因商业化使用或再分发产生的任何责任。
- 使用本软件须遵守所在国家/地区的法律法规、B站服务条款及知识产权要求；如有合规/安全疑虑，请 **立即停止使用并卸载**。
- 本项目 **不采集、存储或上传** 用户的个人隐私数据，Cookie 等敏感信息仅存储在本地，不会发送至任何第三方服务器。
- 本项目 Icon 图标由 GPT Image 2 生成，如有侵权，本项目会立即更换并回以诚挚的歉意。

## License

MIT License
