# diary-search

> OpenClaw 日记全文检索插件 - 为喜欢写日记的你，或因 memory-lancedb 插件替换后需要查找日记的场景

## 功能特性

- **BM25 全文检索** - 基于 MiniSearch 的高效搜索
- **中文分词支持** - Bigram + Unigram 混合分词策略
- **时间衰减排序** - 近期日记优先显示
- **同义词扩展** - 支持中英文同义词查询
- **时间过滤** - 支持今天、昨天、本周、本月等快捷过滤
- **工作区隔离** - 多 agent 场景下的数据隔离

## 一键安装

### ClawHub（推荐）

```bash
clawhub install diary-search
```

### npm

```bash
npm install -g @openclaw/diary-search
```

### 从 GitHub

```bash
git clone https://github.com/你的用户名/diary-search.git
```

## 使用方法

安装后，直接对 OpenClaw 说：

```
搜索我上周关于"项目架构"的日记
搜索 2026-02 月关于"数据库优化"的讨论
查找昨天提到的"bug"
查看我的日记统计
```

## 可用工具

### diary_search

搜索日记内容。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| query | string | ✅ | 搜索关键词，支持中英文混合 |
| limit | number | ❌ | 返回条数，默认 5 |
| time_filter | string | ❌ | 时间过滤器 |
| workspace | string | ❌ | 工作区路径 |

**time_filter 可选值：**
- `today` / `yesterday` / `last_week` / `last_month` / `this_month`
- `YYYY-MM`（如 2026-02）
- `YYYY-MM-DD`（如 2026-02-28）

### diary_stats

获取日记统计信息。

## 配置

在 `~/.openclaw/openclaw.json` 中添加：

```json
{
  "plugins": {
    "enabled": true,
    "load": {
      "paths": [
        "~/.npm-global/lib/node_modules/@openclaw/diary-search"
      ]
    }
  }
}
```

## 与 memory-lancedb 的关系

| 插件 | 检索方式 | 适用场景 |
|------|----------|----------|
| memory-lancedb | 向量检索 | 语义相似性搜索 |
| diary-search | 关键词检索 | 精确查找 |

两者可以同时使用，互补增强记忆检索能力。

## 日记格式

支持 `.md`、`.txt`、`.markdown` 文件，文件名建议使用 `YYYY-MM-DD.md` 格式。

## 同义词配置

编辑 `synonyms.json` 自定义同义词：

```json
{
  "数据库": ["DB", "database", "存储"],
  "项目": ["工程", "project"],
  "架构": ["设计", "结构", "architecture"]
}
```

## License

MIT
