# Mini-CAT 架构说明

## 设计目标

个人规模（≤10 万字原文）的中英双向翻译工作台：记忆库 + 术语库 + 模糊匹配，**纯浏览器端运行**，零依赖、零后端、零运维。

同类开源项目的参考与取舍：

| 项目 | 借鉴点 | 不采用的原因 |
|---|---|---|
| [OmegaT](https://github.com/omegat-org/omegat) | 归一化编辑距离相似度；术语最长匹配优先；多 TM 分级 | 桌面 Java，不便网页协作 |
| [MateCat](https://github.com/matecat/MateCat) | 匹配率分级展示（100%/模糊带）、候选面板交互、匹配统计条 | PHP+MySQL+Redis 全套后端，运维成本高 |
| [Weblate](https://github.com/WeblateOrg/weblate) | 自动学习（确认即入库）、检索(concordance)定位 | Django + 数据库 + Celery，重 |
| TMX 1.4b / TBX-Basic（ISO 30042） | 记忆库与术语库的交换格式，保证与 Trados/memoQ/语料库仓库互通 | — |

本项目的差异化定位：**浏览器本地存储 + 零依赖单页应用**。检索公开渠道未见同类的成熟实现（浏览器端 IndexedDB TM + TMX/TBX 全格式互通），属于 CAT 工具谱系中的"个人纳米级"空白。

## 模块

```
index.html          单页 UI（无框架，原生 DOM 渲染）
js/core.js          纯函数核心：归一化 / 相似度 / 分段 / 术语匹配 / bigram 倒排索引
js/db.js            IndexedDB 封装：tm / terms / projects / meta 四个 store
js/zip.js           极简 ZIP 读取器（central directory + DecompressionStream('deflate-raw')），零依赖
js/msoffice.js      .xlsx（sharedStrings/inlineStr）与 .docx（段落+表格，命名空间无关解析）提取
js/officewrite.js   .docx/.xlsx 生成器：ZIP store 容器（CRC32）+ 最小 OOXML（无边框表格补 tblBorders；xlsx inlineStr/数字单元格）
js/webref.js        联网查阅：MediaWiki action API（origin=*，zh/en/ja）、Met Museum 开放 API（响应形状宽容归一，旧搜索接口 2026-10-01 停用后可小幅适配）、Internet Archive advancedsearch；全部带超时与降级（失败→权威站点直达链接）
js/diff.js          词级 LCS 差分（修订痕迹/预览）
js/richtext.js      译文富文本（文本与格式分开存储）
js/term-engine.js   本地候选术语提取（bilingual-term-extract 打包产物，见 term-engine-provenance.md）
js/segment-ops.js   句对无损拆分/合并
js/revision-plan.js 修订导入计划（匹配/修订/新增分类）
js/io.js            文件格式：TMX 1.4、TBX-Basic、CSV/TSV（BOM+GBK 回退）、JSONL、粘贴对齐、备份
js/app.js           状态管理、事件、渲染、批量匹配调度
tests/              Node 单元测试（core+io 纯函数）与规模基准
```

`core.js` 与 `io.js` 通过 UMD 式导出同时支持浏览器全局与 Node `require`，UI 层之外的逻辑全部可单测。

## 数据模型（IndexedDB `mini-cat` v1）

- `tm`：`{id auto, project, src, tgt, srcNorm, bigrams[], note, origin, date}`，索引 `project`、`srcNorm`
  - `bigrams` 预计算存储，避免每次匹配重算；`srcNorm` 支撑精确匹配快速路径
- `terms`：`{id auto, project, zh, en, note, status, pos, subject}`，索引 `project`
- `projects`：`{name, created, updated, segments[]}` —— 工作区句段（含逐段匹配缓存）随项目持久化
- `meta`：`{key, value}` —— 当前项目等设置

## 匹配管线

```
新原文段 ──normalize──▶ q
                        │
   ┌────────────────────┘
   │ 1. 精确路径：srcNorm === q → 100%
   │ 2. 倒排索引：query bigrams → 候选 id（按共享率排序取前 120）
   │ 3. 门控：长度比 ≥ 0.34 且 Dice(bigram) ≥ 0.18
   │ 4. 精算：有界 Levenshtein（上限 55%·max(len)，逐行提前放弃）
   │ 5. 标点轻罚：去标点后若一致 → 100%；否则取 max(原相似度, 去标点相似度×0.99)
   ▼
score ≥ 50 → 分级（100 / 95-99 / 75-94 / 50-74）→ 候选面板
```

复杂度：单段匹配 ≈ O(候选数 × 段长)。实测 4,000 条 TM × 400 查询段 ≈ 2s（4.9ms/段，M 系列 Mac）。批量匹配按 25 段分块让出主线程，UI 显示进度。

## 分段规则

段落 → 句子：按 `。！？；…` 与 `.!?;` 切分并保留标点；保护小数点（`3.5`）；短于 6 字的句段向后合并（不跨段落）。中英文规则共用，另提供"按段落切分"整段模式。

## 术语匹配

按词长降序贪婪扫描（`indexOf`），已占用区间不再重叠——保证最长术语优先。规模（≤500 条术语 × 段长）无需 Aho-Corasick。

## 与 porcelain-china-corpus 的工作流闭环

```
porcelain-china-corpus                    Mini-CAT
corpus/parallel/*.tmx|csv|jsonl  ──导入──▶ 记忆库
termbase/*.tbx|csv              ──导入──▶ 术语库（2026最终译法，回退 2025）
原文底本(粘贴)                   ──切分──▶ 工作台（匹配/术语高亮/翻译/确认）
确认段落                         ──自动──▶ 记忆库（增量）
记忆库/术语库                    ──导出──▶ tmx|csv|jsonl|tbx 回流仓库与 Trados/memoQ
项目统计（匹配率/进度/字数）      ──人工──▶ 翻译实践报告过程数据
```

## docx/xlsx 提取要点

- 容器为 ZIP：自实现 central directory 解析，method 8 用浏览器原生 `DecompressionStream('deflate-raw')`（Node 17+ 同样可用，便于测试）；无第三方依赖
- xlsx：`xl/workbook.xml` + rels 解析工作表路径；单元格支持 `t="s"`（sharedStrings）与 `t="inlineStr"`（openpyxl 默认）两种字符串布局
- docx：`word/document.xml` 的 body 子元素按 `w:p`/`w:tbl` 分派；OOXML 带命名空间前缀，必须用 `getElementsByTagNameNS('*')` / `localName`，`querySelector` 按限定名匹配会失效
- 双语 docx 三种结构：表格列配对（表头严格匹配"中文≠英文原文"陷阱 + 内容 CJK/拉丁比例校验兜底）、段落交替、先中后英（最优切分点搜索）

## 交付导出

导出对话框分「译文交付」与「翻译数据」两组，交付类支持范围选择（仅已确认段落 / 全部段落，未译留空）：

| 版式 | 格式 | 说明 |
|---|---|---|
| 纯译文 | docx / txt | 按 `seg.para` 将英文句连回原文段落结构（空格连接），标题+正文 |
| 中英对照·段落式 | docx | 逐段"中文 + 斜体灰色英文"交替，适合审校排版 |
| 句句对照表格 | docx / xlsx / csv | 「序号｜中文｜英文」三列表格（docx 带 tblBorders 网格线），与 Evolis 类交付件、平行语料构建同构 |

docx/xlsx 生成走 ZIP store（无压缩）+ 标准 CRC32，最小 OOXML 部件集（Content Types / rels / document.xml·workbook.xml），Word 与 Excel 直接打开；与 msoffice.js 读取器构成 round-trip 测试闭环。

## 联网术语查阅与合规边界

多源聚合：中文/英文维基百科（MediaWiki `list=search`，`origin=*` 跨域）、大都会艺术博物馆开放 API（英文藏名 = 机构背书的"推荐译名"证据，`isHighlight` 藏品优先）、Internet Archive 书目检索。无 CORS 的权威库（术语在线、故宫数字文物库等）以 Bing `site:` 定向直达链接兜底——中国网络环境下抓取失败仅影响对应卡片，不产生空屏。

**合规设计**（对应国社科申报"译文须译者本人完成"）：本模块只做"查阅与参考"，不调用任何生成式翻译；候选译名写入术语库必须人工点击，并自动标注 `[人工采纳译名·来源 日期]` 溯源；工作台译文列永不自动填充网络内容。

## 端侧 MT 建议

使用 Chrome 138+ 内置 `self.Translator` API（zh→en），模型在本机运行，文本不出设备；特性检测失败即隐藏按钮，不影响其他功能。这是不引入任何云端 MT 的前提下唯一的 MT 路径。

## 测试

- `tests/core.test.js`：24 项断言（归一化、相似度带、倒排索引、分段边界、术语贪婪匹配、CSV BOM/引号/TSV、HTML 转义）
- `tests/bench.js`：10 万字规模基准

## 隐私与安全边界

**翻译数据**（记忆库/术语库/句段/批注/修订历史）仅存于本机浏览器 IndexedDB；除下述情形外无网络请求。
- 用户主动触发的"联网查阅"会向维基百科（zh/en/ja）、Met Museum、Internet Archive 发送**查询关键词**——不发送句段、译文或记忆库内容
- 用户主动导入/导出文件
- 多标签页保护：项目记录带版本号，保存走同事务 CAS（saveWithRev），冲突时拒绝写入并提示；配合 Web Locks 建议锁提醒
- 备份恢复经 sanitizeBackup：结构校验、外来 ID 丢弃、派生字段重算；内容不截断（无损往返），由整体大小护栏控制资源消耗
