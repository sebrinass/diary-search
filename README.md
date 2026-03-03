# diary-search

> OpenClaw 日记全文检索插件 - 为喜欢写日记的你，或因 memory-lancedb 插件替换后需要查找日记的场景

## 功能特性

- **BM25 全文检索** - 基于 MiniSearch 的高效搜索
- **中文分词支持** - Bigram + Unigram 混合分词策略
- **时间衰减排序** - 近期日记优先显示
- **同义词扩展** - 支持中英文同义词查询
- **时间过滤** - 支持今天、昨天、本周、本月等快捷过滤
- **工作区隔离** - 多 agent 场景下的数据隔离

## 安装

请使用 OpenClaw 的 diary-search skill 进行安装：

```bash
clawhub install diary-search
```

或查看 [SKILL.md](./SKILL.md) 获取完整的安装方式。

## 使用方法

安装后，直接对 OpenClaw 说：

```
搜索我上周关于"项目架构"的日记
搜索 2026-02 月关于"数据库优化"的讨论
查找昨天提到的"bug"
查看我的日记统计
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
