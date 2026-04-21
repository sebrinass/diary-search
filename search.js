/**
 * MiniSearch 封装 - 日记检索引擎
 * 
 * 功能：
 * 1. BM25 全文检索
 * 2. 时间衰减排序（近期日记优先）
 * 3. 同义词扩展
 * 4. 时间过滤
 */

import MiniSearch from 'minisearch';
import { tokenize } from './tokenizer.js';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

/**
 * 最大文件大小限制（5MB）
 */
const MAX_FILE_SIZE = 5 * 1024 * 1024;

/**
 * 允许的文件扩展名
 */
const ALLOWED_EXTENSIONS = ['.md', '.txt', '.markdown'];

/**
 * 日记文档结构
 * @typedef {Object} DiaryDocument
 * @property {string} id - 文档ID（文件名）
 * @property {string} title - 标题
 * @property {string} content - 内容
 * @property {number} timestamp - 时间戳（从文件名解析）
 * @property {string} filepath - 文件路径
 */

/**
 * 搜索结果结构
 * @typedef {Object} SearchResult
 * @property {string} id - 文档ID
 * @property {string} title - 标题
 * @property {string} content - 内容
 * @property {number} timestamp - 时间戳
 * @property {number} score - BM25 分数
 * @property {number} finalScore - 最终分数（含时间衰减）
 * @property {string} matchedText - 匹配的文本片段
 */

/**
 * 时间过滤器类型
 * @typedef {'today' | 'yesterday' | 'last_week' | 'last_month' | 'this_month' | string} TimeFilter
 */

/**
 * 日记搜索引擎类
 */
export class DiarySearchEngine {
  constructor(options = {}) {
    this.options = {
      timeDecayFactor: options.timeDecayFactor ?? 0.1,
      synonyms: options.synonyms ?? {},
      logger: options.logger ?? console
    };
    
    /** @type {MiniSearch|null} */
    this.miniSearch = null;
    /** @type {Map<string, DiaryDocument>} */
    this.documents = new Map();
    /** @type {string|null} */
    this.currentWorkspace = null;
  }

  /**
   * 从文件名解析日期
   * @param {string} filename - 文件名（如 2026-02-28.md）
   * @returns {number|null} 时间戳
   */
  parseDateFromFilename(filename) {
    // 匹配 YYYY-MM-DD 格式
    const match = basename(filename).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) {
      const [, year, month, day] = match;
      return new Date(parseInt(year), parseInt(month) - 1, parseInt(day)).getTime();
    }
    return null;
  }

  /**
   * 从 Markdown 内容提取标题
   * @param {string} content - Markdown 内容
   * @returns {string} 标题
   */
  extractTitle(content) {
    // 提取第一个 # 标题
    const match = content.match(/^#\s+(.+)$/m);
    if (match) {
      return match[1].trim();
    }
    // 提取第一行非空内容
    const firstLine = content.split('\n').find(line => line.trim().length > 0);
    return firstLine ? firstLine.trim().slice(0, 50) : '无标题';
  }

  /**
   * 加载日记目录
   * @param {string} diaryDir - 日记目录路径
   * @returns {number} 加载的文档数量
   */
  loadDiaryDirectory(diaryDir) {
    if (!existsSync(diaryDir)) {
      this.options.logger.warn?.(`日记目录不存在: ${diaryDir}`);
      return 0;
    }

    const files = readdirSync(diaryDir);
    let loadedCount = 0;

    for (const file of files) {
      // 验证文件扩展名
      const ext = extname(file).toLowerCase();
      if (!ALLOWED_EXTENSIONS.includes(ext)) continue;

      const filepath = join(diaryDir, file);
      
      try {
        const stat = statSync(filepath);
        
        // 跳过目录
        if (stat.isDirectory()) continue;
        
        // 检查文件大小，防止内存溢出
        if (stat.size > MAX_FILE_SIZE) {
          this.options.logger.warn?.(`文件过大，跳过: ${file} (${(stat.size / 1024 / 1024).toFixed(2)}MB)`);
          continue;
        }

        const content = readFileSync(filepath, 'utf-8');
        const timestamp = this.parseDateFromFilename(file) || stat.mtimeMs;
        const title = this.extractTitle(content);

        const doc = {
          id: file,
          title,
          content,
          timestamp,
          filepath
        };

        this.documents.set(file, doc);
        loadedCount++;
      } catch (err) {
        this.options.logger.warn?.(`加载日记失败: ${file}, ${err.message}`);
      }
    }

    // 重建索引
    this.buildIndex();
    
    return loadedCount;
  }

  /**
   * 构建 MiniSearch 索引
   */
  buildIndex() {
    this.miniSearch = new MiniSearch({
      fields: ['title', 'content'],
      storeFields: ['id', 'title', 'timestamp'],
      tokenize: (text) => tokenize(text),
      searchOptions: {
        tokenize: (text) => tokenize(text),
        prefix: true,
        fuzzy: 0.2
      }
    });

    const docs = Array.from(this.documents.values());
    this.miniSearch.addAll(docs);
    
    this.options.logger.info?.(`索引构建完成: ${docs.length} 篇日记`);
  }

  /**
   * 扩展查询词（同义词）
   * @param {string} query - 原始查询
   * @returns {string} 扩展后的查询
   */
  expandQuery(query) {
    const tokens = tokenize(query);
    const expanded = [...tokens];

    for (const token of tokens) {
      const synonyms = this.options.synonyms[token];
      if (synonyms && Array.isArray(synonyms)) {
        expanded.push(...synonyms);
      }
    }

    return expanded.join(' ');
  }

  /**
   * 计算时间衰减因子
   * @param {number} timestamp - 文档时间戳
   * @param {number} now - 当前时间戳
   * @returns {number} 衰减因子 (0-1)
   */
  calculateTimeDecay(timestamp, now = Date.now()) {
    if (this.options.timeDecayFactor <= 0) {
      return 1;
    }

    // 计算天数差
    const daysDiff = (now - timestamp) / (1000 * 60 * 60 * 24);
    
    // 指数衰减: e^(-decayFactor * days)
    return Math.exp(-this.options.timeDecayFactor * daysDiff);
  }

  /**
   * 解析时间过滤器
   * @param {TimeFilter} filter - 时间过滤器
   * @returns {{start: number, end: number}|null} 时间范围
   */
  parseTimeFilter(filter) {
    if (!filter) return null;

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    switch (filter) {
      case 'today':
        return { start: today.getTime(), end: Date.now() };
      
      case 'yesterday': {
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        return { start: yesterday.getTime(), end: today.getTime() };
      }
      
      case 'last_week': {
        const weekAgo = new Date(today);
        weekAgo.setDate(weekAgo.getDate() - 7);
        return { start: weekAgo.getTime(), end: Date.now() };
      }
      
      case 'last_month': {
        // 安全地计算一个月前的日期
        const monthAgo = new Date(today);
        const targetMonth = monthAgo.getMonth() - 1;
        monthAgo.setMonth(targetMonth);
        // 处理跨年情况：如果月份没有正确回退，说明跨年了
        // JavaScript 的 setMonth 会自动处理跨年
        return { start: monthAgo.getTime(), end: Date.now() };
      }
      
      case 'this_month': {
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        return { start: monthStart.getTime(), end: Date.now() };
      }
      
      default:
        // 尝试解析 YYYY-MM 格式
        if (/^\d{4}-\d{2}$/.test(filter)) {
          const [year, month] = filter.split('-').map(Number);
          const start = new Date(year, month - 1, 1);
          const end = new Date(year, month, 0, 23, 59, 59);
          return { start: start.getTime(), end: end.getTime() };
        }
        // 尝试解析 YYYY-MM-DD 格式
        if (/^\d{4}-\d{2}-\d{2}$/.test(filter)) {
          const [year, month, day] = filter.split('-').map(Number);
          const start = new Date(year, month - 1, day);
          const end = new Date(year, month - 1, day, 23, 59, 59);
          return { start: start.getTime(), end: end.getTime() };
        }
        return null;
    }
  }

  /**
   * 提取匹配文本片段
   * @param {string} content - 完整内容
   * @param {string} query - 查询词
   * @param {number} contextLength - 上下文长度
   * @returns {string} 匹配片段
   */
  extractMatchedText(content, query, contextLength = 100) {
    // 验证输入
    if (!content || typeof content !== 'string') {
      return '';
    }
    
    const tokens = tokenize(query);
    if (tokens.length === 0) {
      const snippet = content.slice(0, contextLength);
      return content.length > contextLength ? snippet + '...' : snippet;
    }

    // 查找第一个匹配的 token
    for (const token of tokens) {
      if (!token) continue;
      const index = content.indexOf(token);
      if (index !== -1) {
        const start = Math.max(0, index - 30);
        const end = Math.min(content.length, index + token.length + contextLength - 30);
        let snippet = content.slice(start, end);
        
        if (start > 0) snippet = '...' + snippet;
        if (end < content.length) snippet = snippet + '...';
        
        return snippet;
      }
    }

    const snippet = content.slice(0, contextLength);
    return content.length > contextLength ? snippet + '...' : snippet;
  }

  /**
   * 执行搜索
   * @param {string} query - 搜索关键词
   * @param {Object} options - 搜索选项
   * @returns {SearchResult[]} 搜索结果
   */
  search(query, options = {}) {
    if (!this.miniSearch) {
      return [];
    }

    const {
      limit = 5,
      timeFilter = null,
      timeDecay = true
    } = options;

    // 扩展查询词
    const expandedQuery = this.expandQuery(query);
    
    let rawResults;
    try {
      rawResults = this.miniSearch.search(expandedQuery, {
        prefix: true,
        fuzzy: 0.2
      });
    } catch (err) {
      this.options.logger?.warn?.(`MiniSearch 搜索异常: ${err.message}, query="${expandedQuery}"`);
      return [];
    }

    // 解析时间过滤器
    const timeRange = this.parseTimeFilter(timeFilter);

    // 处理结果
    const results = [];
    const now = Date.now();

    for (const result of rawResults) {
      const doc = this.documents.get(result.id);
      if (!doc) continue;

      // 时间过滤
      if (timeRange) {
        if (doc.timestamp < timeRange.start || doc.timestamp > timeRange.end) {
          continue;
        }
      }

      // 计算最终分数
      const timeDecayFactor = timeDecay 
        ? this.calculateTimeDecay(doc.timestamp, now)
        : 1;
      
      const finalScore = result.score * timeDecayFactor;

      results.push({
        id: doc.id,
        title: doc.title,
        content: doc.content,
        timestamp: doc.timestamp,
        score: result.score,
        finalScore,
        matchedText: this.extractMatchedText(doc.content, query)
      });
    }

    // 按最终分数排序
    results.sort((a, b) => b.finalScore - a.finalScore);

    // 限制返回数量
    return results.slice(0, limit);
  }

  /**
   * 格式化日期为 YYYY-MM-DD 格式（本地时间）
   * @param {number} timestamp - 时间戳
   * @returns {string} 格式化的日期
   */
  formatDate(timestamp) {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /**
   * 格式化搜索结果为 Markdown
   * @param {SearchResult[]} results - 搜索结果
   * @returns {string} Markdown 格式结果
   */
  formatResultsAsMarkdown(results) {
    if (results.length === 0) {
      return '## 日记检索结果\n\n未找到匹配的日记。';
    }

    const lines = ['## 日记检索结果', ''];

    // 找出最高分用于归一化
    const maxScore = Math.max(...results.map(r => r.finalScore));

    for (const result of results) {
      const dateStr = this.formatDate(result.timestamp);
      // 归一化分数到 0-100 范围
      const normalizedScore = maxScore > 0 
        ? Math.round((result.finalScore / maxScore) * 100)
        : 0;

      lines.push(`### ${dateStr}.md (相关性: ${normalizedScore}%)`);
      lines.push(`> ${result.matchedText.replace(/\n/g, '\n> ')}`);
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * 获取统计信息
   * @returns {Object} 统计信息
   */
  getStats() {
    return {
      documentCount: this.documents.size,
      oldestDocument: this.documents.size > 0 
        ? Math.min(...Array.from(this.documents.values()).map(d => d.timestamp))
        : null,
      newestDocument: this.documents.size > 0
        ? Math.max(...Array.from(this.documents.values()).map(d => d.timestamp))
        : null
    };
  }
}

export default DiarySearchEngine;
