---
name: diary-search
description: "日记全文检索插件，支持中文分词、BM25搜索、时间衰减排序。适用于喜欢写日记的 OpenClaw 用户，或因 memory-lancedb 插件替换后需要查找日记的场景。"
metadata:
  openclaw:
    emoji: "📔"
    requires:
      bins: []
    install:
      - id: npm
        kind: node
        package: "diary-search"
        label: "Install via npm"
      - id: clawhub
        kind: clawhub
        slug: diary-search
        label: "Install via ClawHub"
---

# Diary Search

日记全文检索插件，让你可以搜索 OpenClaw 记录的日记内容。

## 适用场景

- 喜欢用 OpenClaw 记录日记的用户
- 替换了 memory-lancedb 插件后需要查找历史记忆
- 需要按关键词、时间范围搜索日记

## 安装方式

### 方式一：ClawHub 一键安装

```bash
clawhub install diary-search
```

### 方式二：npm 安装

```bash
npm install -g diary-search
```

安装后，在 `~/.openclaw/openclaw.json` 中添加插件路径：

```json
{
  "plugins": {
    "enabled": true,
    "load": {
      "paths": [
        "~/.npm-global/lib/node_modules/diary-search"
      ]
    }
  }
}
```

### 方式三：从 GitHub 安装

```bash
git clone https://github.com/sebrinass/diary-search.git
cd diary-search
npm install
```

然后在配置中添加本地路径：

```json
{
  "plugins": {
    "load": {
      "paths": ["/path/to/diary-search"]
    }
  }
}
```

## 可用工具

### diary_search

搜索日记内容。

**参数：**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| query | string | ✅ | 搜索关键词，支持中英文混合 |
| limit | number | ❌ | 返回条数，默认 5 |
| time_filter | string | ❌ | 时间过滤器 |
| workspace | string | ❌ | 工作区路径 |

**time_filter 可选值：**
- `today` - 今天
- `yesterday` - 昨天
- `last_week` - 最近一周
- `last_month` - 最近一月
- `this_month` - 本月
- `YYYY-MM` - 指定月份（如 2026-02）
- `YYYY-MM-DD` - 指定日期

**使用示例：**
```
搜索我上周关于"项目架构"的日记
搜索 2026-02 月关于"数据库优化"的讨论
查找昨天提到的"bug"
```

### diary_stats

获取日记统计信息。

```
查看我的日记统计
```

## 配置选项

在 `openclaw.plugin.json` 中可配置：

| 选项 | 默认值 | 说明 |
|------|--------|------|
| defaultWorkspace | ~/.openclaw | 默认工作区 |
| diarySubdir | memory | 日记子目录 |
| defaultLimit | 5 | 默认返回条数 |
| timeDecayFactor | 0.1 | 时间衰减因子 |

## 与 memory-lancedb 的关系

- **memory-lancedb**：向量检索，适合语义相似性搜索
- **diary-search**：关键词检索，适合精确查找

两者可以同时使用，互补增强记忆检索能力。

## 日记格式

支持 `.md`、`.txt`、`.markdown` 文件，文件名建议使用 `YYYY-MM-DD.md` 格式。
