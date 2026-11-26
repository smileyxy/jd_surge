# i百联每日签到（Surge 专用模块）

将原 Loon 插件改写为 **Surge iOS 专用模块**，支持自动抓取多账号凭证、每日定时签到、自动完成浏览类积分任务，以及 Surge 信息面板状态展示与一键手动签到。

## 模块安装链接

在 Surge iOS 的「模块 → 安装新模块」中粘贴以下链接：

```text
https://raw.githubusercontent.com/smileyxy/jd_surge/main/ibailian/ibailian_signin.sgmodule
```

> 使用自动抓包前，请确认 Surge 已开启 **MITM** 并安装信任 CA 证书。

## 文件说明

| 文件 | 说明 |
| --- | --- |
| `ibailian_signin.sgmodule` | Surge 专用模块（`http-request` 抓包 + `cron` 定时 + `panel` 面板 + `MITM`） |
| `ibailian_gettoken.js` | Surge 请求头抓包脚本，自动提取 `membertoken` / `devicekey` / `sm-deviceid` |
| `ibailian_signin.js` | Surge 签到、积分任务与信息面板展示/触发脚本 |

## 模块参数说明（`#!arguments`）

安装模块后可在 Surge 模块详情页直接修改以下参数（无需额外安装 BoxJS）：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `cron` | `0 9 * * *` | 每日定时签到 Cron 表达式（5 段式，**请勿包含逗号**） |
| `account_count` | `1` | 参与签到的账号数量，依次读取 `IBL_Creds_1` ~ `IBL_Creds_N` |
| `capture_slot` | `1` | 抓包写入槽位，切换为 `2`/`3` 后打开 App 即可自动抓取第 2/3 个账号凭证 |
| `notify_mode` | `all` | 定时任务通知策略：`all`（始终通知）/ `smart`（仅异常或新增积分 > 0 时通知）/ `error`（仅异常通知）/ `off`（静默） |

> 兼容兜底：当脚本未收到对应模块参数时，会自动回退读取持久化存储键 `IBL_AccountCount`、`IBL_CaptureSlot`、`IBL_NotifyMode`。模块参数优先级高于持久化存储兜底值。

## 多账号使用流程

1. 安装模块并开启 MITM，保持默认 `capture_slot=1`。
2. 打开「i百联」App 进入积分/签到页，收到 `i百联 Token - 账号1 已更新` 通知即完成账号 1 抓包。
3. 如需添加账号 2：在模块参数中将 `capture_slot` 改为 `2`、将 `account_count` 改为 `2`，在 App 内切换账号并再次打开积分页，收到 `账号2 已更新` 通知即可。
4. 如需手动编辑或查看凭证，键值名为 `IBL_Creds_1`、`IBL_Creds_2`…，格式为：
   ```json
   {"membertoken":"...","devicekey":"...","smDeviceid":"..."}
   ```

## 信息面板交互说明

模块内置了 `i百联每日签到` 单面板智能交互：

- **自动刷新（定时/首页展示）**：**零网络请求**，仅读取本地持久化存储展示各账号凭证就绪状态（Token 已脱敏）及上次执行摘要（`IBL_LastRun`）。
- **手动点击面板**：立即执行一轮完整的签到与积分任务，并在执行完成后直接刷新面板卡片显示本次结果与总积分（不额外弹出重复通知）。

## 致谢

原 Loon 插件与接口逻辑来自 [@辣堡](https://github.com/a974881061/Blue)（`Loon/ibailian_signin.plugin`、`Scripts/ibailian_gettoken.js`、`Scripts/ibailian_signin.js`）。
