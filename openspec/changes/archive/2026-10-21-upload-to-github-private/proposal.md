# Proposal

## Why

项目从 2026-09-18 独立成目录至今，**没有任何版本控制**：没有 `.git`、没有 `.gitignore`，
477MB 的 `app/node_modules`、585MB 的 `dist/`、以及运行时数据目录 `数据/` 与源码混在同一个树里。
改错一行代码、误删一个文件，没有任何回滚手段 —— 族谱这种数据几十年的家底项目，这个风险不该继续背。

用户 2026-10-21 决定：**先以私有仓库上传 GitHub 测试效果**，公开与否以后再定。

## What Changes

- **新增仓库根 `.gitignore`**（当前不存在）：排除 `app/node_modules/`、`dist/`、`数据/`、
  `数据底稿/`、`*.log`、`*.bak`、`*.migrated-*`。
- **`git init` + 首个提交**（中文注释），推送前人工核对暂存区清单。
- **`gh repo create <name> --private --source=. --push`**：建私有仓库并推送。
  `gh auth login` 需用户本人在浏览器完成授权（CLI 已装、未登录）。
- **`app/package.json` 打包输出相对化**：`directories.output` 由
  `"D:\\族谱pc端项目\\dist"` 改为 `"../dist"`。解析结果不变（`app/` 的上一级 = 仓库根），
  本机产物仍落 `D:\族谱pc端项目\dist\`，但 clone 到任何机器都能打包 —— 当前写法在无 D 盘的
  机器上直接失败。
- **版本号 0.2.80 → 0.2.81**，`app/README.md` 更新日志顶部追加一条（构建配置可移植化 + 建仓）。

**明确不做**：

- **不做任何数据脱敏**。曾怀疑 `sample.js` / `数据底稿/` 里的「林广德」等示例是真实家人信息，
  用户 2026-10-21 明确否认：那是编造的演示数据。转公开时也无需脱敏。
- **不动 `app/electron/paths.js` 的 `DEFAULT_DATA_DIR`**（`'D:\\族谱pc端项目\\数据'`）。
  它是有单测、有 D→C→userData 三级 fallback 的**产品行为**（`tests/db.test.js:75` 守着），
  不是构建路径问题。改它属于产品决策，不搭这次建仓的车。
- **不动 `app/scripts/verify-asar.js`** 里硬编码的 `D:\族谱pc端项目\程序\...` /
  `D:\族谱pc端项目\dist\...` —— 本地 asar 校验脚本，只在作者机器上有意义，clone 上用不到。
- **不补 `LICENSE`、不加 `repository` 字段** —— 私有测试阶段不需要，转公开时再补。

## Capabilities

### New Capabilities

- `repo-hygiene`: 仓库卫生 —— 版本控制忽略清单覆盖全部非源码资产（依赖、产物、运行时数据、
  临时文件）；构建输出不依赖开发者机器的绝对路径；远端仓库默认私有，转公开须显式决策。
  本能力约束的是**项目交付管线**的不变量，不是应用行为；应用行为本次零变化。

### Modified Capabilities

无。现有四个 capability（`kinship-addressing`、`person-search`、`topbar-layout`、
`ui-icon-sizing`）均为应用行为，与本次建仓无关，requirement 不变。

## Impact

| 位置 | 改动 |
|---|---|
| `.gitignore`（仓库根，**新建**） | 6 组忽略规则，见 What Changes |
| `app/package.json` | `build.directories.output` 绝对路径 → `../dist`；`version` 0.2.80 → 0.2.81 |
| `app/README.md` | 更新日志顶部追加一条 |
| `git` | 首次 `init` + 提交；新增私有远端 `github.com/<user>/family-tree`（仓库名暂定，推送前可改） |

- **不涉及**任何 `app/src/`、`app/electron/`、`app/tests/` 文件 —— 应用代码与测试零改动，
  `npm test`（core + db + library）预期原样通过，跑它为回归确认。
- **依赖不变**：仍 `html2canvas` + `sql.js`。
- **上传体量**：忽略规则生效后约 1MB（源码 + 文档 + openspec + 截图），无单文件超限问题。
- **`数据/` 被排除与「示例数据真假」无关**：它是运行时状态，将来一定沉淀真实族谱数据，
  无论内容真假都不进版本控制。
