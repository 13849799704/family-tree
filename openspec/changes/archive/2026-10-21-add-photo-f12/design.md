# Design

## Context

动机见 proposal.md；行为契约见 `specs/photo-management/spec.md`（下称「规格」）。实现层面的既有现状与硬约束：

- **入口已留**：`panel.js` 的 `sectionPhotos()` 渲染 `data-act="add-photo"` 按钮，`app.js` 的 `runAction` 里只回一句「待接入」toast。
- **底层已留**：`people.photos`（JSON 数组列）与 `people.avatar` 已建表；`avatar` 全代码无赋值点（`dialog.js` 保存时仅保留原值），是白纸；per-book `photos/` 目录已由 `ensureLayout` 建好（`paths.js:37`）。
- **硬约束一（写路径）**：`db:write` 是全量重写——一个事务内 DELETE + INSERT 全表（`db.js:271`）。base64 进行会让每次保存越来越慢，这是「文件进目录、行里只存文件名」的根本原因。
- **硬约束二（导出画布）**：`app.js:1058` 的坑位注释明令：照片不得以 `file://` 上画布（污染 → `toDataURL` 抛 SecurityError，F11 导出图片直接失败），必须走自定义协议或 base64 内联，**不许** `webSecurity:false`。
- **导入导出现状**：导出走 `exportScopeDialog`（全谱 / 当前树二选一）→ `exportFile()`；导入走 `offerImport()`（建成新谱 / 覆盖当前谱二选一）。两个对话框就是照片选项的天然挂点。

## Goals / Non-Goals

**Goals：**

- 照片文件进 per-book `photos/` 目录，数据库只存文件名；`avatar` 存主头像文件名（与 photos 数组同一命名空间，不复制文件）。
- 上传即生成缩略图；面板只加载缩略图的 dataURL，原图按需（灯箱）加载。
- 导出可选内联照片（自包含迁移），导入自动恢复内联照片并落盘到目的地谱。
- 删除有路径逃逸防护；文件缺失处处降级为空槽，不崩、不写脏数据。

**Non-Goals：**

- 网页版照片能力（项目已决定不实施网页版；无桥环境仅按规格降级）。
- 拆 `photos` 表：文件已在磁盘，行里只剩文件名，数组足够；README §287 预留的「拆表」在本设计下无必要。
- HEIC/RAW 等格式支持、裁剪编辑、拖拽上传、原图压缩（照片获取不易，原件原样保存）。

## Decisions

### D1 存储与命名

文件复制进该谱 `photos/`（复制而非引用——用户源文件可能移动/删除，谱要自包含）。文件名 `<personId>-<rand6>.<ext>`：personId 形如 `p_me` / `p_wus`（ASCII，见 `sample.js`），人在资源管理器里能认出是谁的；`<rand6>` 防同人同格式撞名；扩展名取原文件小写。缩略图固定为同目录 `<name>.thumb.jpg`（如 `p_me-a1b2c3.jpg` → `p_me-a1b2c3.thumb.jpg`）。

`avatar` 存主头像文件名，渲染时与 photos 走同一条取图通道。删除被设为头像的照片时，同时清空该成员的 `avatar`（一致性，见 D3）。

备选：base64 进行（否：硬约束一）；独立 photos 表（否：过度设计）；引用用户原路径（否：谱不再自包含，违背 paths.js「整夹拷走」的设计意图）。

### D2 渲染通道：IPC + base64，缩略图预生成

```
上传：add() ─→ 系统对话框多选 ─→ 逐个：白名单校验 → 复制进 photos/
                                       → nativeImage 解码试错（失败记 rejected）
                                       → nativeImage 中心裁方 + 缩到 320px 存 .thumb.jpg（q80）
                                       （缩略图失败不阻塞：回退原图）

渲染：panel/tree ─→ photos.thumb(name) ─→ IPC 读 .thumb.jpg ─→ dataURL ─→ <img src>
                        └ 缩略图缺失 ─→ photos.original(name) ─→ dataURL
```

- 用 Electron 内置 `nativeImage`（resize + toJPEG），**零新依赖**（现有依赖仅 electron / sql.js / html2canvas / electron-builder）。
- 缩略图是**方形中心裁切**（crop → resize 320×320），不是等比缩放：头像位与照片格
  都是方框，而 **html2canvas 不支持 `object-fit`**（它把图直接拉伸进框里），
  非方图进方框 = 导出图里的头像被挤扁（屏幕上却是好的，因为浏览器认 object-fit）。
  旧版非方形缩略图在读取时自动重生成（不迁数据、不动原图）。
- 备选 `file://`：硬约束二明令禁止。备选自定义协议 `photo://`：html2canvas 1.4.1 对自定义协议是否污染画布**未验证**，且要处理协议注册与 CORS 头；收益仅是省一次 IPC，不值得为它担风险。
- 渲染层维护 `Map<name, dataUrl>` 缓存；数据集加载 / 切谱 / 照片增删时失效重建。带头像的人在数据集加载后预热（通常不多）；面板照片懒加载——异步 resolve 后若面板仍是同一人则重渲染（resolve 前显示既有占位：字或空槽）。
- 画布（F11 导出图片）里只出现 dataURL，从根上不碰坑位注释的红线。

### D3 删除安全

主进程 `photos:remove(names)`：`path.resolve` 后必须位于**当前谱** `photosDir` 之内（前缀 + 路径分隔符判定），否则拒绝该条目（防历史脏数据 / 手工篡改的 `..\` 逃逸）；连同 `.thumb.jpg` 一并删。ENOENT 视为已删除；EPERM 等（文件被资源管理器/预览占用）返回错误——渲染层**保留**该数据库引用并明确报错，用户关闭占用后重试。不制造「库说删了、文件还在」的漂移，也不静默丢引用。

删除照片时若 `p.avatar === name`，同时清空 `avatar`。

### D4 格式校验与大小

扩展名白名单 `jpg/jpeg/png/webp/gif/bmp`（nativeImage 可解码集）。复制进 `photos/` 后试解码，失败 → 删副本、记 rejected，**同批其他文件照常入库**（规格：坏格式不得影响好文件）。不做大小上限（用户 2026-10-21 决定：本地磁盘、照片获取不易，体积再大也收）。

### D5 导入导出

**导出**（挂在现有 `exportScopeDialog`，加复选框「包含照片（文件会大很多）」）：

- 勾选：从**导出的那份数据集副本**（可能是 `scopeToTree` 裁剪后的，只收集它的引用）收集被引用文件名（`people[].photos` + `people[].avatar`，去重）→ `photos:readMany(names)` 拿 dataUrl map → 以顶层 `_photos: {name: dataUrl}` 嵌入 JSON。
- 不勾选：维持现状，JSON 只含文件名。
- `db:write` 的 `writeDataset` 只读 people/relationships/version/viewpoint，`_photos` 天然被忽略，无 schema 风险。

**导入**（`_photos` 在 `offerImport` 入口从 dataset 摘下，保持 dataset 干净；map 顺着流程带下去）：

- `建成新谱` 分支：`createBook` 返回后（主进程已切到新谱，absorb 刷新缓存）→ `photos.restore(map)` → `applyBookSwap` 之后 toast 报数。
- `覆盖当前谱` 分支：`applyImport` 保存后 → `photos.restore(map)` → toast 报数。
- **顺序理由**：照片必须落进**目的地**谱的目录；新建谱时 `lib:create` 之前当前谱还是旧的那本，早一步 restore 会把照片写错谱。先文件后库：写库失败留孤儿文件（无害），反过来会主动制造缺失引用。
- restore 只写原图（缩略图缺失走 D2 回退，不在这里生成）。
- 导入结果统计：恢复了 N 张；另外 M 个被引用但文件缺失（不含内联的旧文件）——缺失数进 toast，界面按规格降级。

### D6 面板与灯箱

- 照片区 3 个照片槽 + 第 4 格：≤3 张时第 4 格是虚线「＋」（现状）；>3 张时第 4 格变「+N」角标。照片悬停出现两个小按钮：「设为主头像」（星形）、「删除」（×，确认弹窗）。
- 点缩略图或「+N」开灯箱：网格全览 → 点开单张大图（原图 dataURL）+「设为主头像 / 删除 / 关闭」。
- 无 `genogramFS` 桥时不渲染添加入口（规格要求，可选链 `genogramFS.photos?.add`）。

### D7 IPC 面（preload `genogramFS.photos`，桌面版才有）

| 方法 | 行为 | 返回 |
|---|---|---|
| `add()` | 系统多选对话框 → 复制 + 校验 + 缩略图 | `{ok, added:[name], rejected:[{file, reason}]}` |
| `thumb(name)` / `original(name)` | 读 dataURL | `{ok, dataUrl}` 或 `{ok:false, error}` |
| `remove(names[])` | D3 安全删除 | `{ok, removed:[], errors:[{name, error}]}` |
| `readMany(names)` | 导出用，批量读 dataUrl | `{ok, map}` |
| `restore(map)` | 导入用，dataUrl 写盘 | `{ok, written, errors}` |
| `exists(names)` | 批量查存在性（只 stat，不读内容） | `{ok, existing[]}` |

`exists` 是实现时补的第 7 个方法：导入后要报「缺失数」（spec 要求），
而 readMany 会把整张图读出来只为问一句「在不在」——大照片上这是白读，
所以单开一个只 stat 的轻量查询。

主进程侧逻辑集中在一个新模块（如 `electron/photoStore.js`），纯函数部分（文件名生成/清洗、photosDir 内校验、引用收集、缩略图命名）不 import electron，可在纯 Node 下单测；`add()` 的「复制+校验+缩略图」编排也放这里，handler 与测试共用同一入口。

### D8 成员删除与照片

删除成员**不删其照片文件**（照片获取不易，且删除成员已是确认制危险操作，不再叠加不可逆损失）。孤儿文件留在 `photos/`，体积代价小；这与规格无冲突（规格只约束单个照片的删除行为）。

## Risks / Trade-offs

- [超大图 nativeImage 解码内存峰值（不做大小上限的代价）] → 缩略图失败仅跳过（回退原图），不让上传失败；原图渲染吃内存是用户选择，软件不替用户决定。
- [EPERM 删文件（图片被资源管理器/预览占用）] → 保留引用 + 明确报错，关闭占用后重试（D3）。
- [内联导出的 JSON 可达数百 MB] → 对话框明示体积代价；renderer 侧 stringify/parse，opt-in 功能可接受。
- [导入 restore 时磁盘满/写入失败] → 逐文件收集错误，成功的保留、失败报数，导入整体成功（缺失降级）。
- [历史脏数据路径逃逸] → D3 前缀校验 + 纯函数单测补 `..\`、绝对路径、空字符串用例。
- [smoke 无法驱动物理对话框] → `add()` 的编排逻辑抽到 `photoStore.js`，smoke 用夹具图 + `restore()` + 直接 fs 落盘覆盖无对话框路径；对话框路径靠单测。

## Migration Plan

无 schema 变更、无数据迁移：现存库 `photos` 均为 `[]`（或测试造的 `['a.jpg','b.jpg']`，按缺失文件降级为空槽）。回滚 = 还原代码；`photos/` 里的文件留着无害。

## Open Questions

- 灯箱单张视图要不要键盘左右翻页 / Esc 关闭？（纯体验增强，不影响规格与任务拆分，实现时定）
- 以后要不要支持把图片文件直接拖到谱树节点上完成添加？（增强项，未定）
