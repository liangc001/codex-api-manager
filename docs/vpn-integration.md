# VPN 集成

## 使用和构建

Windows 便携版是 `Codex-API-Manager.exe`。首页直接显示 VPN，选择可信的便携文件夹（同一级目录包含 `data` 和 `cores`），等待导入后选择地区并连接。首次启动不会查找或导入已有 VPN 数据。“自动选择”按当前网络实测、仍有效且经过出口验证的 HTTPS 延迟排序；指定地区只接受对应国家或地区的实际出口。

首页的 **线路详情** 提供线路检测、测速和 agy。代理范围与启动选项位于 **设置 → VPN**，更新 ResearchLab、导入 v2rayN／Clash 和诊断放在该页的 **线路导入与排查**。首次仍需导入便携目录来安装本地核心；后续导入只替换切换台内的对应配置。“打开切换台时连接”使用最后一次成功连接的地区和代理模式；开机启动登记当前便携 EXE，不修改旧 VPN 的开机启动项。

源码开发：`npm run vpn:build` 后执行 `npm run desktop`。打包：`npm run build:exe`（Windows x64，需 .NET 8 SDK 和项目 npm 依赖，SDK 可通过 `API_SWITCHBOARD_DOTNET` 指定）。产物包含独立的自包含 broker 和第三方许可，不包含核心、个人配置、许可证密钥或测试数据。正式版沿用公开仓库的应用内更新，首次运行输入启动密码后记住当前电脑；参见 [登录说明](access.md)。

## 代理与退出

- **仅本应用和从此启动的客户端**：不写 Windows 系统代理。Electron 后端的模型、用量、连接测试、请求监控上游等使用独立代理会话，不仅是界面。Codex 桌面版由 VPN 面板启动；Claude Code 由本应用的 CLI 按钮启动。需要运行 Codex CLI 时，在自己的终端为该进程设置 HTTP(S) 代理为 `http://127.0.0.1:10839`，并设置 `NO_PROXY=localhost,127.0.0.1,::1`。已经启动的客户端不会自动换环境变量。应用新发的外部请求在线路失效时不自动直连；断开或停止服务后，宿主恢复接入前的网络路径。核心仍保留原路由规则与直连例外。
- **接管 Windows 系统代理**：沿用原代理所有权和精确恢复机制；只影响遵从 Windows 系统代理的应用，不是全机流量隧道。保留原绕行规则、ProxyGuard、watchdog 和 Job Object。断开与真正退出会恢复租约，若设置已被其他程序接管则保留其选择。
- 普通代理的固定本机入口为 `127.0.0.1:10839`，Codex 随普通线路切换。agy 是独立的美国线路，使用 `127.0.0.1:10838`。两个端口都转发流量，不接受控制命令。退出面板、收起托盘都保留连接；“停止 VPN 服务”或退出切换台会等待清理。用显式代理启动的客户端在服务停止后不会自动直连，需要重新打开或清除其进程代理环境。
- 旧版 VPN 可保留，两个后端使用相同的单实例互斥约定，不能同时使用。想用集成版连接时从旧 VPN 托盘正常退出；想切回旧版时先停止集成服务。旧 VPN 的数据、租约和运行目录不与集成版共用。本次没有退出或修改正在运行的旧 VPN。

## 本地文件与审查入口

导入先验证再复制，不写回用户选择的目录，不重建缺失的密钥，不覆盖已有导入。导入产物位于 EXE 旁 `data/vpn/data` 与 `data/vpn/cores`，使用仅当前用户和 SYSTEM 可访问的 ACL。带原密钥的数据可解密，整个 `data/vpn` 不应共享。租约、线路偏好和临时核心配置在 `%LOCALAPPDATA%/ApiSwitchboard/Vpn`。不要共享运行目录；脱敏诊断只包含有限状态，不含 IP、节点名、密钥或原始日志。

- `vpn/backend/`：复用 CampusLink 后端；`vpn/licenses/`：原第三方许可。
- `vpn/Program.cs`、`vpn/BrokerFacade.cs`、`vpn/PortableImport.cs`：控制宿主、连接与导入边界。
- `desktop/vpn-client.cjs`、`desktop/main.cjs`：进程生命周期、网络与 IPC；`public/vpn-ui.js`、`public/index.html`、`public/workspace-ui.css`：界面。

## 本地控制协议

Electron 按需启动 broker，随机命名 `\\.\pipe\api-switchboard-vpn-<32 hex>`。仅当前 Windows 用户可访问；不监听 TCP。每连接一个 UTF-8 JSONL 请求（上限 8 KiB），响应 `{ok:true,result:{version:1,...}}` 或 `{ok:false,error:"..."}`。请求对象含 `v:1` 和 `op`，另可带：

| 操作 | 参数与行为 |
| --- | --- |
| `status` / `regions` | 阶段、忙碌、模式、地区、普通端口、出口、延迟、测速列表 |
| `import` | `directory`，由桌面端可信目录对话框提供 |
| `connect` | `region` 为选项代码或 `auto`，`mode` 为 `app` 或 `system`；改变接管模式须先断开 |
| `disconnect` / `cancel-connect` | 断开普通线路或取消当前连接 |
| `benchmark` / `cancel-benchmark` / `latency` | 启动/取消全地区测速，或刷新当前延迟 |
| `check-sources` / `update-researchlab` | 检测各线路来源；使用已导入订阅更新 ResearchLab |
| `import-v2ray` / `import-clash` | 断开后导入，`directory` 分别为原文件夹或 YAML 路径 |
| `set-preference` | `key` 为 `autoConnect` 或 `autoRecover`，`value` 为布尔值 |
| `agy` / `disconnect-agy` / `open-codex` | 独立美国线路与打开 Codex 桌面版 |
| `agy-settings` | 返回本机 agy PowerShell 代理环境命令；不执行命令 |
| `diagnostics` / `shutdown` | 脱敏状态；等待 `DisposeAsync` 后结束。宿主提前结束时 broker 也会清理 |

启动连接、导入或测速后以 `status` 观察进度，成功收到请求不等于操作已完成。常规取消使用独立取消令牌；服务生命周期只在真正退出时结束。

## 验证范围

`npm test` 和隔离集成测试 `npm run vpn:fixture`、`node test/vpn-integration.mjs <可信的核心目录>`。后者仅复制 `cores` 下两项二进制到临时测试目录，生成合成节点、独立高位端口和模拟 HTTPS 测量，不读取原 `data`，不接管系统代理，也不启动 Codex 或 aTrust。

真实线路实测、系统代理接管与故障恢复、跨账户 IPC 拒绝、Codex/aTrust 共存，以及休眠和网络切换均另在独立 Windows 验收机验证；这些不属于此次本机验证结果。
