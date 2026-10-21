# Tasks

> 顺序原则：**先把所有本地改动做完，再一次性 `git init` 提交** —— 初始提交即最终状态，
> 不留给世界一个「已知不可移植」的第一版。远端操作全部集中在后两组。
> 依据：design.md D1（忽略清单按性质分组）、D3（只相对化 `package.json` 的 output）。

## 1. 提交前的本地改动（忽略清单 + 构建可移植化 + 留痕）

- [x] 1.1 在仓库根新建 `.gitignore`，按性质分六组并逐条写清「为什么」：
  `app/node_modules/`（可再生）、`dist/`（可再生）、`数据/`（运行时状态，将来必沉淀真实数据）、
  `数据底稿/`（草稿，将来可能放真数据）、`*.log`、`*.bak` / `*.migrated-*`。
  验证：`git check-ignore 数据 数据底稿 app/node_modules dist` 四个路径全部命中
  （先 `git init` 再验，或直接对 `.gitignore` 内容逐条目测）。
- [x] 1.2 `app/package.json` 的 `build.directories.output` 由
  `"D:\\族谱pc端项目\\dist"` 改为 `"../dist"`。
  验证：读回 JSON 确认值为 `../dist`；确认 `build` 配置块内不再有任何盘符绝对路径；
  `buildResources` 等其余相对路径未动。
- [x] 1.3 `app/package.json` 的 `version` 由 `0.2.80` 改为 `0.2.81`。
  验证：读回确认。
- [x] 1.4 `app/README.md` 更新日志**顶部**追加一条 v0.2.81，写明：
  构建输出从绝对路径改为相对路径（本机产物落点不变，clone 后可构建）、
  仓库建立版本控制并上传私有远端、`.gitignore` 按性质排除四类非源码资产。
  验证：新条目位于更新日志第一节，旧条目未被删改。
- [x] 1.5 跑 `npm test`（core + db + library 三组）做回归确认。
  验证：0 失败。本次不碰 `src/`、`electron/`、`tests/`，跑它为确认 1.2/1.3 的
  `package.json` 编辑没有连带影响。

## 2. 首次提交

- [ ] 2.1 `git init`（要 `main` 分支就 `git init -b main`，否则默认 `master`），
  然后 `git add .`，**先 `git status` 核对暂存清单再往下走**。
  验证：清单里只有源码、文档、`openspec/`、`.gitignore`、`app/package.json`、
  `app/README.md` 等预期文件；**不出现** `数据/`、`数据底稿/`、`dist/`、
  `app/node_modules/`；文件总数在百级（约 100~200），不是几千。
- [ ] 2.2 `git commit -m "初始提交：族谱 PC 端代码与文档"`（中文注释）。
  验证：`git log --oneline` 有且仅有一条；作者为全局身份（王寄林）。

## 3. GitHub 授权（只能用户本人操作）

- [ ] 3.1 用户在 PowerShell 跑 `gh auth login`，按提示浏览器授权。
  验证：`gh auth status` 显示已登录。** agent 不代做此步**，卡住就报告。

## 4. 私有远端与推送

- [ ] 4.1 `gh repo create family-tree --private --source=. --push`
  （仓库名暂定，用户想改就在这条命令里改；`--private` 显式带上，不依赖默认值）。
  验证：命令输出创建成功；`gh repo view --json visibility` 返回 `PRIVATE`。
- [ ] 4.2 浏览器打开远端仓库页，**肉眼核对文件树**。
  验证：只见 `app/`（展开无 `node_modules`）、`文档/`、`openspec/`、`README.md`、
  `.gitignore`；**无** `数据/`、`数据底稿/`、`dist/`。
  这一步是 spec「四类非源码资产均被忽略」的最终验收，截图或文件列表留证。

## 5. 收尾核对

- [ ] 5.1 确认远端默认分支与本地一致（`master` 或 `main`，以 2.1 的选择为准），
  且远端文件数与本地暂存前一致。验证：`git ls-files | measure` 计数与 2.1 的清单吻合。

## Workflow follow-up

- 实现与核对全部完成后，用 `/opsx:archive` 归档，把 `repo-hygiene` 落进
  `openspec/specs/`。归档后确认 `openspec/specs/repo-hygiene/spec.md` 已生成，
  3 条 requirement 与本次 delta 一致。
- **转公开的触发条件**（不要主动做）：用户显式决定公开时才动。届时无需数据脱敏
  （示例数据虚构，已确认），只剩三项卫生工作：① 提交邮箱（QQ）换 GitHub noreply
  或用户明确接受暴露；② 补 `LICENSE`（建议 MIT）；③ `package.json` 补 `repository`
  字段（建仓后用户名已知，现在补等于猜）。
