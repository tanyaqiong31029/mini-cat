# 贡献指南

1. Fork → 分支 → 修改 → `npm test` 全绿 → 提交 PR。
2. 提交信息格式：`类型: 摘要`（类型：feat/fix/docs/test/chore）。
3. 运行时保持**零 npm 依赖**；测试专用依赖放 devDependencies。
4. 所有面向用户的字符串用中文；代码注释说明"为什么"而非"是什么"。
5. 涉及数据存储/导入导出的改动必须附带往返测试（见 tests/ 现有用例）。
6. 多个会话/工具并行开发本仓库时，动手前先 `git fetch` 并 rebase 到最新 main。
