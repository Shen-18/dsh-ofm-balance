<div align="center">

<img src="icon.svg" width="96" alt="dsh-ofm-balance" />

# dsh-ofm-balance

**在 DSH 侧栏显示 [Our Free Model](https://github.com/Ebony-Vinyl/dsh-our-free-model)（OFM）网关各渠道的剩余额度。**

> 一张常驻侧栏的小卡片，把「哪个渠道还有多少额度」摊开给你看。

[![简体中文](https://img.shields.io/badge/lang-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-red.svg)](README.md)
[![English](https://img.shields.io/badge/lang-English-blue.svg)](README.en.md)

[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.1--rc.2-4c6ef5?style=flat-square&labelColor=454a54)](package.json)
[![license](https://img.shields.io/badge/license-MIT-2EA44F?style=flat-square)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Shen-18/dsh-ofm-balance?style=flat-square&label=%E2%98%85&color=08C)](https://github.com/Shen-18/dsh-ofm-balance)
[![dependencies](https://img.shields.io/badge/dependencies-0-success?style=flat-square)](package.json)

</div>

---

## 预览

<table>
  <tr>
    <td align="center" width="42%">
      <img src="docs/screenshots/card-collapsed.png" alt="折叠态：渠道名 + 剩余百分比" />
      <br /><sub><b>折叠态</b> — 显示当前对话使用的渠道及其剩余百分比</sub>
    </td>
    <td align="center" width="58%">
      <img src="docs/screenshots/card-expanded.png" alt="展开态：每个渠道一行，含进度条、剩余量与百分比" />
      <br /><sub><b>展开态</b> — 每个渠道一行：进度条 · 剩余量 · 百分比</sub>
    </td>
  </tr>
</table>

- **折叠态**：标题右侧显示**当前对话使用的渠道**及其剩余百分比，格式 `渠道名 · 百分比`。
  找不到当前渠道时就退回到剩余最少的那个渠道——那才是最该看的一个。
- **展开态**：每个渠道一行，含进度条、剩余量与百分比；数据来自网关的真实配额接口。
- **刷新**：点击「刷新」立即探测；页面可见时按周期自动轮询。

## 它解决什么问题

OFM 把十来个渠道（CodeArts、TRAE、Qoder……）挂在同一个网关后面。每个渠道各有自己的配额，
而网关默认只在你**主动去查**的时候才告诉你。于是很常见的两个问题：

- 「我刚才是走哪个渠道花的额度？」——折叠态直接回答。
- 「哪个渠道快用完了？」——按剩余量排序，一眼扫过去。

这张卡片把这两件事都放进侧栏，不占对话、不用点击、不打断你。

> **它同时支持两套 Our Free Model。** 「Our Free Model」这个名字下有两个产品：装在 DSH 里的
> [官方插件](https://github.com/Ebony-Vinyl/dsh-our-free-model)，以及独立的桌面应用。它们各自维护账号池，
> 互不相通。本插件会先探测你装了哪一套（或两套都在），只探测到一套就直接用，两套都在才问你一次。详见
> [数据来源](#数据来源)。


## 显示哪些渠道

**默认只显示「已登录账号」的渠道**，其余按目录列出但隐藏，可在设置里手动打开。

判据是数据源自己的账号清单（`provider.status` → `accounts.total > 0`），不是 DSH profile 里
声明的模型 id。这一点在 0.7.0 改过，原因是旧判据在两个方向都会错：

- profile 是**快照**：账号早就没了，它还一直声明那个渠道，卡片于是堆满永远读不到数字的行；
- 刚登录的渠道**可能还没写进 profile**，真实账号反而被藏起来。

账号清单是实时真值，也是 `credits.balances` 唯一肯回答的前提。两个产品（插件 / 桌面应用）
的 `provider.status` 返回结构完全一致，因此一条规则覆盖两边。

| 来源 | 数据出处 | 含义 |
| --- | --- | --- |
| **已登录** | 数据源 `provider.status` → `accounts.total > 0` | 你在这个渠道登录了账号 |
| **目录** | 插件内置的渠道清单（与网关控制台一致，当前 13 个） | 该产品支持哪些渠道 |
| **已提供** | `GET /v1/models` → `data[].channel` | 此刻有模型可用 |
| **可读取** | `credits.balances` 返回了数字 | 此刻余额读得到 |

> **目录不是封闭的。** 如果数据源提供了目录里没有的渠道，它依然会被列出来并使用标题化的显示名。
> 上游新增渠道后，本插件无需更新即可工作——这一点有单元测试守着：
> `a freshly logged-in channel outside the catalogue still earns a row`。

### 默认规则

| 情况 | 默认行为 |
| --- | --- |
| 已登录账号 | **显示**。即使此刻读不到余额，也保留该行并说明原因 |
| 目录中有、但没登录账号 | **隐藏**。可手动打开，用于盯一个以后可能会登录的渠道 |
| 已登录但读不到 | **显示**，并如实标注（如「网关未提供该渠道」） |
| 渠道未登录账号 | 查询成功但返回空账号列表，显示 **「未在该渠道登录账号」** |
| 无账号但手动打开 | **显示**，并提示「尚未登录该渠道的账号，仅供查看」 |

未登录账号的渠道会如实标注，而不是报错或留空——查得到和查不到是两件事，卡片把它们分开说。

### 如何调整（图形界面）

在 DSH 的 **插件** 页打开本插件（`dsh-ofm-balance`）详情页，正文顶部的 **数据源** 与
**渠道显示** 区块即控制面板。渠道分成两组：

- **已登录账号** — 数据源里确实有账号的渠道
- **其余渠道（未登录账号）** — 目录中有、但还没有账号的

每个渠道一行，包含：

- 左侧复选框控制是否显示
- 渠道名与一行说明（已登录 / 未登录账号 / 当前未提供）
- 右侧状态标签

**勾选未登录的渠道时会弹窗确认**——那种渠道没有账号可读，现在不会有任何数字。
改动即时生效并写入 `$DSH_HOME/dsh-ofm-balance/settings.json`。

> **为什么不放在宿主自动生成的配置表单里**：DSH 会从插件的 `Config` schema 自动生成设置页，
> 但它只渲染标量字段；`array` 类型的渠道列表在那里渲染不出可用的复选框，也无法在
> 「显示未配置渠道」时给出确认对话。所以本插件自带面板。

#### 为什么这个区块能排在「来源信息」之上

面板通过 `plugins.detail.section` 插槽注册，而该插槽是**追加**在官方页面自己的区块
（来源信息、当前版本、更新）之后的——注册时给的 `order` 只在槽位内部排序，改不了与官方区块的相对位置。

所以位置由两件事共同保证：

1. 详情页正文是 `flex-direction: column`，面板根节点设 `order: -1`，CSS 层面即可排到最前；
2. 渲染回调里再做一次保守的前插（仅当父容器确实是 flex column 时才动），作为 CSS 不可用时的兜底。

两者都不依赖宿主的内部排序实现。宿主若改变布局，面板会退回插槽给的位置，而不会报错。

### 如何调整（配置文件）

也可以直接编辑 `$DSH_HOME/dsh-ofm-balance/settings.json`：

```json
{
  "version": 1,
  "hidden": ["qoder"],
  "revealed": ["moonshot"]
}
```

| 字段 | 作用 |
| --- | --- |
| `hidden` | 要隐藏的**已登录账号**渠道 |
| `revealed` | 要额外显示的**无账号**渠道 |
| `source` | 记住的数据源选择（`plugin` / `desktop`） |

删除该文件即恢复默认（已登录的全显示、无账号的全隐藏）。**被隐藏的渠道不参与探测，因此不浪费请求。**

## 颜色

进度条与百分比按**剩余比例**连续渐变——不是已用比例，也不是分档跳变。

色相经过实测调整。第一版把色相线性铺满整段，结果在健康区间显示一片看不出差别的绿色
（80% → 100% 只跨 23°）。现在改用锚点，把高位推向青色：

| 剩余 | 色相 | 观感 |
| ---: | ---: | --- |
| 100% | 178° | 青 |
| 90% | 147° | 春绿 |
| 80% | 123° | 绿 |
| 60% | 78° | 黄绿 |
| 40% | 48° | 琥珀 |
| 20% | 25° | 橙 |
| 0% | 0° | 红 |

饱和度与亮度也随数值变化，使整条刻度读起来是一条连续量表，而非色轮。
**语义不可翻转**：100% 永远是健康的青，0% 永远是红。

折叠态摘要里，渠道名保持默认文字色，**只有百分比着色**——两者都上色会让名字看起来像状态标签，与数字争夺注意力。

## 安装

```bash
dsh plugin --profile <profile> add github:Shen-18/dsh-ofm-balance
```

也可以使用仓库地址或本地路径：

```bash
dsh plugin --profile <profile> add https://github.com/Shen-18/dsh-ofm-balance
dsh plugin --profile <profile> add link:/绝对路径/dsh-ofm-balance
```

> 本机 profile 名不一定是 `web`，请替换成自己的（例如桌面端常见的是 `desktop`）。

### 预构建安装包（免构建授权）

每个版本都附带一个预构建的安装包，供插件市场直接提供：

```
https://github.com/Shen-18/dsh-ofm-balance/releases/latest/download/dsh-ofm-balance.tgz
```

该文件名**不含版本号**，因此 `latest/download/` 在每次发版后仍然有效，不会像
「资产名带版本号」那样在下一个版本发布时静默 404。从该 tgz 安装时不需要源码构建，
因此也免去 `allowBuilds` 构建授权这一步。

手动安装：

1. 把本目录加入 profile 的 `package.json` → `dependencies`
2. 把包名 `dsh-ofm-balance` 追加到 `dsh.profile.bundles`
3. 在 profile 目录执行 `pnpm install`
4. 重启宿主

宿主半区改动需重启；客户端半区改动刷新页面即可。

## 配置

宿主侧的部署级配置（在 profile 补丁或插件配置里）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关闭后不探测、不注册路由 |
| `source` | `auto` | 数据源：`auto` 自动判定，`plugin` 读 DSH 插件，`desktop` 读桌面应用 |
| `baseUrl` | `http://127.0.0.1:18900` | 桌面应用的网关地址（`source=plugin` 时不用） |
| `credentialRoute` | `ourfreemodel` | 凭据与配置所属的 provider 路由名 |
| `pollIntervalSec` | `60` | 轮询间隔（30–3600 秒） |
| `timeoutMs` | `20000` | 单渠道超时。冷启动实测约 10.5 秒，不宜调低 |
| `hiddenChannels` | `[]` | （初始值）隐藏的已登录渠道 |
| `revealedChannels` | `[]` | （初始值）额外显示的无账号渠道 |

> 渠道开关的**实际值**存在 `$DSH_HOME/dsh-ofm-balance/settings.json`，由插件详情页的面板维护。
> 配置里的 `hiddenChannels` / `revealedChannels` 只作为首次运行的初始值。
> 数据源的**实际选择**也存在同一个文件里（`source` 键），优先级高于配置项——避免配置项与用户点击互相打架。

## HTTP 接口

全部限制为**本机回环访问**（非 `127.0.0.1` / `::1` 一律 `403`）。API Key 由宿主解析，不会下发到浏览器。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/dsh-ofm-balance/overview` | 当前快照与探测报告 |
| `POST` | `/api/dsh-ofm-balance/refresh` | 立即探测并返回新快照 |
| `GET` | `/api/dsh-ofm-balance/channels` | 渠道分类结果（含显示名称），供设置面板使用 |
| `POST` | `/api/dsh-ofm-balance/visibility` | 保存渠道开关，请求体 `{ hidden, revealed }` |
| `GET` | `/api/dsh-ofm-balance/sources` | 数据源探测结果、当前选择、是否需要询问 |
| `POST` | `/api/dsh-ofm-balance/sources` | 切换数据源，请求体 `{ source: "plugin" \| "desktop" }` |

## 数据来源

**有两套互不相通的 Our Free Model**，名字相同、账号各自独立，本插件会先探测再决定读哪一套：

| 数据源 | 是什么 | 怎么读 |
| --- | --- | --- |
| `plugin` | 安装在 DSH 里的 `dsh-our-free-model` 插件 | 内核 RPC 通道 `channel-pack`，方法 `credits.balances` |
| `desktop` | 独立的桌面应用（`127.0.0.1:18900`） | `POST {baseUrl}/api/management/channels/rpc` |

桌面应用还用它自己的接口发现渠道：`GET {baseUrl}/v1/models` → `data[].channel`；桌面路径的凭据取自宿主凭据服务的
`OURFREEMODEL_API_KEY`，**只在宿主进程内使用**。

### 为什么插件源必须走内核 RPC

官方插件有意把它的管理接口锁在 DSH 内核里：`/api/our-free-model/*` 与 `/api/channel-pack` 都要经过
`connection.admit()` 的浏览器令牌校验。实测从外部调用（包括回环地址、匹配的 Origin、以及从凭据库里取出
browser-session 密钥）**一律返回 401**。

但它把同一套接口注册成了进程内的 Fetch 路由，因此**同一个进程里的插件可以合法调用**——本插件的宿主半身
正是这样读取的：取 `connection` 服务、用共享的 owner Peer、向 `/api/channel-pack` 投递内核信封。

两套来源返回的积分结构**完全相同**，因此共用同一份归一化与分母修正逻辑，不存在两套算法漂移的问题。

### 首次运行的询问规则

- 只探测到一套 → 直接用，不打扰；
- 两套都在且用户尚未选择 → 卡片展开区顶部提示一次，可一键切换；
- 用户选择后写入 `settings.json`，之后不再询问（可在插件详情页随时改）。

若已选的数据源后来不可用（应用关了、插件卸了），会自动回退到另一套，而不是把卡片钉在空结果上。


## 冷启动行为

宿主启动时，插件会在凭据服务就绪之前挂载。本插件对此的处理：

- 探测拿不到凭据时**不缓存失败结果**，而是把渠道标记为「读取中」，1 秒后自动重试；
- 连续 3 次仍拿不到，才判定为真的未配置，并在卡片上给出可操作的提示（告诉你该配置哪个环境变量）；
- 网关的首次冷探测约需 10.5 秒，因此首次请求会立即返回带渠道名的占位行，数字随后填入——不会出现空白卡片。

结果：**打开 DSH 后无需手动刷新**，余额会自行出现。

## 已知限制

- 网关**没有批量接口**，每次探测按渠道并发请求；隐藏的渠道不请求。
- `gemini` 的配额查询需要本机能访问 Google。未开代理时该渠道返回 `balance: null` 与
  `配额查询网络失败`，插件显示为「不可用」，**不影响其它渠道**；代理可用后下一轮自动恢复。
- 网关返回的积分包有两处会**算错百分比**，都以实测数据修正：

  1. **重叠的 `used`**。同一个 `used` 会同时出现在聚合包与子包里（codearts 的「总积分包」与
     「赠送积分包」都是 349.31），把每个包的 `used` 相加会把分母从真实的 **7500** 抬到 7849.31。
     判别方式是找到 `remaining` 等于 `balance.total` 的那个包（即聚合包），用它**自己的** `used`。
  2. **失效的包**。网关把已过期的包标为 `active: false`（buddy 有 4 个失效裂变包，
     `total` 100 / `used` 100 / `remaining` 0）。它们已不属于本周期额度，计入分母会把
     4539 抬到 4939。

  两者叠加后，codearts 从 91.1% 修正为 **95.3%**，buddy 从 78.9% 修正为 **85.8%**。
  当网关**完全没有**返回积分包明细、或返回值形状无法解释时，插件**不显示百分比**——
  没有可信的分母就不该编造一个数字（尤其是 100%，那会把「已用掉大半」显示成「从未使用」）。
- 未在某个渠道登录账号时，余额接口**仍可查询**，只是返回空账号列表；插件如实标注，不算失败。

## 设计说明

| 决策 | 原因 |
| --- | --- |
| 宿主 / 浏览器半区分离 | API Key 只在宿主进程内使用，浏览器只见归一化后的快照 |
| `Promise.allSettled` 扇出 | 单个渠道慢或失败不能拖垮其它渠道 |
| 缓存优先 + 预热态 | 冷启动约 10.5 秒；首次请求立即返回占位行，避免首屏空白 |
| 凭据缺失时不缓存结果 | 冷启动时凭据服务晚于插件就绪，缓存「没有 key」会把一次瞬时状态变成永久错误 |
| 分类规则抽到 `lib/channels.js` | 纯函数、无 I/O，是策略所在，也最值得测试 |
| 渠道开关走 `plugins.detail.section` | 宿主自动表单渲染不了数组字段，也给不出「未配置渠道」的确认对话 |
| 开关存自己的 JSON 而非 profile 补丁 | 插件由 bundle 补丁挂载，profile 里没有它的行可改；写自己的文件不会破坏用户配置 |
| 显示名称由宿主下发 | 插件在提供未知渠道的网关部署上也能给出正确名称与标题化兜底 |

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `lib/gateway.js` | 网关协议：发现渠道、查询余额、归一化 |
| `lib/channels.js` | 渠道分类与可见性策略（纯函数） |
| `lib/service.js` | 缓存、轮询、凭据就绪重试、构建快照 |
| `lib/patch.js` | 渠道开关的持久化（原子写：先写临时文件再 rename） |
| `lib/index.js` | 宿主挂载、路由、配置、会话事件 |
| `lib/client.js` | 侧栏卡片 + 插件详情页的渠道开关面板 |

零运行时依赖。`@deepseek-ai/*` 全部由宿主提供，不作为 `dependencies` 声明。

## 支持的渠道

插件内置的目录（与网关控制台一致）：

| id | 名称 | 所属 |
| --- | --- | --- |
| `codearts` | CodeArts | 华为云 |
| `buddy` | WorkBuddy 国内版 | 腾讯 |
| `workbuddy` | WorkBuddy 国际版 | 腾讯 |
| `lobsterai` | LobsterAI | 有道 |
| `qoder` | Qoder | 阿里系 |
| `qodercn` | Qoder 中国版 | 阿里系 |
| `trae` | TRAE | 字节 |
| `cline` | Cline | — |
| `loomy` | Loomy | — |
| `raccoon` | Raccoon | — |
| `minimax` | MiniMax Code | — |
| `zcode` | ZCode | — |
| `gemini` | Gemini | Google |

这份目录是**下限而非过滤条件**：未登录账号的渠道会如实显示，目录之外的渠道也会照常出现。

## 开发

```bash
npm run check   # 语法检查（node --check）
npm test        # 单测：渠道分类 + 设置持久化（node --test）
```

测试覆盖渠道分类策略与设置持久化的边界情况（缺失文件、损坏文件、原子写、未知形状容忍），
不依赖网络，也不消耗任何额度。

## 版本

- **0.8.0** — 数据源询问改为**只问一次**：关闭提示也算已回答（写入 `sourcePromptSeen`），但「关闭」与「选择」是两种状态——关闭不会钉死某个源，之后仍按 uto 自动选可用的一套；提示里注明后续在「插件详情页 → 数据源」切换。单复数单位合并（credit/credits → credits）；文案去掉「仅可查看」这类废话。
- **0.7.0** — 渠道显示判据改为**「是否已登录账号」**（`provider.status` → `accounts.total > 0`），不再依据 DSH profile 声明的模型 id。旧判据两头都错：profile 是快照，账号没了还一直声明，卡片堆满读不到数字的行；刚登录的渠道又可能还没写进 profile，真实账号反被隐藏。两套数据源的 provider.status 结构一致，因此一条规则覆盖两边。删除 profile 读取与 60 秒轮询等死代码。
- **0.6.0** — 支持**两套 Our Free Model 数据源**。此前卡片固定读桌面应用的 `127.0.0.1:18900`；
  装了 DSH 官方插件后，两边的账号池互不相通，卡片显示的是另一套账号。现在会先探测
  `plugin`（官方插件，走 DSH 内核的 `channel-pack` RPC）与 `desktop`（桌面应用，走 HTTP），
  只探测到一套就直接用，两套都在才询问一次，并可在插件详情页随时切换；已选项失效时自动回退。
  两套来源共用同一份归一化与分母修正逻辑。新增 `lib/sources.js`、`lib/plugin-source.js`
  与 23 个测试（共 56 个）。
- **0.5.1** — 修正百分比分母的两处错误。①同一个 `used` 会同时出现在聚合包与子包里
  （codearts 的「总积分包」与「赠送积分包」都是 349.31），相加会把分母算大；改为找出
  `remaining` 等于 `balance.total` 的聚合包、用**它自己的** `used`。②已过期的 `active:false`
  包不属于本周期额度（buddy 有 4 个），计入分母会把 4539 抬到 4939。
  codearts 由 91.1% 修正为 **95.3%**，buddy 由 78.9% 修正为 **85.8%**。网关未返回积分包明细时
  不显示百分比，而不是编造 100%。新增 `lib/gateway.test.js`，用真实网关返回值锁住这些算法。
- **0.5.0** — 列出网关支持的**全部渠道**（而不是只有当前有模型路由的几个），通过内置目录补齐；
  已登录账号的渠道正常查余额，未登录的如实标注。已配置渠道的识别增加文件回退
  （某些宿主不向插件暴露路由设置命名空间，此前会把所有渠道误判为「未配置」）。
  设置面板改为分组布局，行高与说明文字放宽。
- **0.4.3** — 设置区块真正移到「来源信息」之上。上一版依赖注册的 `order`，但该槽位是追加到
  官方区块之后的，`order` 只在槽位内部生效、改不了与官方区块的相对位置；改用 CSS `order: -1`
  （详情页正文是 flex column）并附 JS 兜底前插。
- **0.4.2** — 侧栏卡片改为完全透明（侧栏本身即透明，任何底色都会显出「贴上去的框」），
  仅在悬停时给出极淡反馈；圆角收到 8px。
- **0.4.1** — 侧栏卡片去掉边框、背景改用侧栏同色系，降低视觉突兀感。
- **0.4.0** — 插件详情页新增渠道开关面板（`plugins.detail.section`）；修复冷启动「缺少凭据」
  不自动恢复的问题；渠道名称改由宿主下发；文档重构。
- **0.3.0** — 支持网关提供的目录外渠道。
- **0.2.0** — 折叠态改为「渠道名 · 剩余百分比」（仅百分比着色）；颜色改为连续渐变；折叠态显示当前对话渠道。
- **0.1.0** — 首个版本。

## 许可

[MIT](LICENSE)
