# Tasks

## 1. 主进程照片存储模块

- [x] 1.1 新建 `app/electron/photoStore.js`：纯函数（文件名生成与 personId 清洗、photosDir 内路径校验、缩略图命名、从数据集收集被引用文件名含 avatar 与去重）与 `add` 编排（白名单校验 → 复制 → nativeImage 解码试错 → 缩略图 320px/q80），nativeImage 以参数注入以便单测；验证：模块在纯 Node 下可 import，导出的纯函数行为符合 design D1/D3/D4。
- [x] 1.2 新建 `app/tests/photos.test.js` 覆盖纯函数：`..\` 逃逸、绝对路径、空字符串、脏 personId、引用收集（photos + avatar、去重、scopeToTree 副本）；在 `package.json` 增加 `test:photos` 并并入 `npm test`；验证：`npm test` 全绿。
- [x] 1.3 在 `app/electron/main.js` 注册 `photo:add` / `photo:thumb` / `photo:original` / `photo:remove` / `photo:readMany` / `photo:restore` 六个 handler（一律走当前谱 photosDir，remove 按 D3 校验）；验证：`npm start` 启动后，在 devtools 里对六个 IPC 各 invoke 一次，返回结构与 design D7 表一致。
- [x] 1.4 在 `app/electron/preload.cjs` 暴露 `genogramFS.photos`（六方法，桌面版才有）；验证：启动后 `window.genogramFS.photos.add` 为函数，网页版（dev-server）下为 undefined 且控制台无报错。

## 2. 渲染层取图、头像与面板

- [x] 2.1 新建照片缓存模块（如 `app/src/core/photos.js`）：`Map<name, dataUrl>` 缓存、`ensure(names)` 懒加载（先 thumb 后 original 回退）、`invalidate()` 在切谱/数据集替换时清空；验证：单测或运行期观察——同一照片第二次渲染不再发 IPC（缓存命中）。
- [x] 2.2 `app/src/ui/tree.js` 头像渲染改为：`p.avatar` → 缓存取图 → dataURL，取不到回退 `avatarGlyph`；数据集加载后预热所有带头像成员；验证：给一个成员设上头像文件名后，谱树该节点显示照片，删掉文件后回退首字。
- [x] 2.3 `app/src/ui/panel.js` 照片区重写：缩略图 dataURL 渲染、悬停出现「设为主头像 / 删除」、>3 张时第 4 格显示「+N」、无 genogramFS 桥时不渲染添加入口；删除走确认弹窗；验证：手工点一遍——添加/悬停/删除/+N 各行为符合规格场景。
- [x] 2.4 `app/src/app.js`：`add-photo` 分支落地（调 `photos.add()`，按返回结果追加 photos 数组并 toast 拒绝项）、删除照片时同步清 `avatar`（若删的是主头像）、`deletePerson` 不动照片文件（design D8）；验证：跑 `npm run test:delete` 与 `npm run test:edit` 无回归。
- [x] 2.5 灯箱：缩略图与「+N」均打开照片全览浮层，点开单张大图（原图 dataURL）带「设为主头像 / 删除 / 关闭」；验证：浮层开合、单张切换、操作后面板与谱树同步刷新。

## 3. 导入导出联动

- [x] 3.1 导出：`exportScopeDialog` 增加「包含照片（文件会大很多）」复选框；勾选时从**导出的数据集副本**收集引用文件名 → `photos:readMany` → 顶层 `_photos` 嵌入；验证：勾选与不勾选各导出一份，前者 JSON 内含 `_photos` 且引用齐全，后者不含；`db:write` 往返不受 `_photos` 影响（`npm run test:db` 绿）。
- [x] 3.2 导入：`offerImport` 入口从 dataset 摘下 `_photos`；「建成新谱」分支在 `applyBookSwap` 后、「覆盖当前谱」分支在保存后调 `photos.restore(map)`，toast 报「恢复 N 张 / M 个文件缺失」；验证：用 3.1 勾选导出的文件走一遍两个分支，照片完整恢复；用不含照片的旧导出导入，缺失数正确报出。

## 4. 集成验证与文档

- [x] 4.1 `app/tests/electron-smoke.js` 增加照片链路：夹具 PNG 经 `photos.restore` 落盘 → 断言面板 `<img src>` 为 data: → 给成员设头像 → 走一遍 F11 导出 PNG 断言 `toDataURL` 不抛 SecurityError（app.js:1058 坑位注释的回归测试）；验证：`npm run test:e2e` 绿。（**已跑绿**：2026-10-21 全套 116 条断言 ALL PASSED。过程中修掉四处测试自身的问题 —— ① 复刻的导出步骤漏了「删小字姓名行」（存量红灯的真正原因）；② 截图步 `capturePage()` 在软件渲染下**永不返回**，死等会卡死整场（加 10 秒超时 + 接住抛错）；③ 主进程单实例锁让「应用开着时跑冒烟」秒退（加 `GENOGRAM_NO_SINGLE_INSTANCE` 开关）；④ 「淡出后 DOM 清干净」死等 320ms 会在机器忙时误报（改轮询）。）
- [x] 4.2 `app/tests/db.test.js` 补充：真实文件名形态的 photos 数组往返、avatar 文件名往返、含路径字符的脏数据不被写坏；验证：`npm run test:db` 绿。
- [x] 4.3 文档：根 `README.md` §1 当前状态与 §9 F12 行改为已实现、§3 目录说明补照片文件命名；`app/README.md` 更新日志顶部追加 v0.2.85 条目（按项目约定第三位修订号 +1，当前 0.2.84）；同步 `app/package.json` 版本号；验证：README 描述与实际行为一致，`node -e "require('./app/package.json').version"` 输出 0.2.85。

## Workflow follow-up

- 实现完成后运行 `/opsx:apply` 收尾核对：`openspec validate add-photo-f12 --strict` 通过后再归档。
- 归档后按项目发布流程核对版本号（0.2.85）与更新日志，再决定是否打包。
