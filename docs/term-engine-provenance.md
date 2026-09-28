# term-engine.js 来源与重建

`js/term-engine.js` 为**打包产物**，源代码来自本维护者自己的 [bilingual-term-extract](https://github.com/tanyaqiong31029) 项目（MIT，统计式双语术语提取：n-gram 候选 + C-value/PMI + Dice 共现投票 + 验证器）。

- **打包脚本**：`scripts/bundle-term-engine.cjs`
- **重建方法**：`node scripts/bundle-term-engine.cjs <bilingual-term-extract 源码目录>`
  （读取源项目 `scripts/core/{util,stopwords,tokenizer,candidates,vote}.js` 与 `scripts/validate.js`，内联为可在浏览器运行的 UMD 模块，保留 MIT 许可头）
- **运行时形态**：`root.MiniCatTermEngine`，无外部依赖；仅被"候选术语复核"功能调用，全部计算在本机完成
- **上游变更同步**：修改源项目后重新执行打包脚本并提交产物；`git log --follow js/term-engine.js` 可追溯历次同步
