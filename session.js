/**
 * Session Search Engine - 会话检索引擎
 * 
 * 功能：
 * 1. 解析 JSONL 会话文件
 * 2. 按日期列出会话
 * 3. 搜索消息内容
 * 4. 导出纯对话文本
 */

import MiniSearch from 'minisearch';
import { tokenize } from './tokenizer.js';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const MAX_FILE_SIZE = 10 * 1024 * 1024;

export class SessionSearchEngine {
  constructor(options = {}) {
    this.options = {
      timeDecayFactor: options.timeDecayFactor ?? 0.1,
      logger: options.logger ?? console
    };
    
    this.miniSearch = null;
    this.messages = new Map();
    this.sessions = new Map();
    this.sessionDir = null;
  }

  parseTimestamp(ts) {
    if (!ts) return null;
    if (typeof ts === 'number') {
      return ts;
    }
    if (typeof ts === 'string') {
      return new Date(ts).getTime();
    }
    return null;
  }

  extractTextContent(content) {
    if (!Array.isArray(content)) return '';
    
    const texts = [];
    for (const item of content) {
      if (item.type === 'text' && item.text) {
        texts.push(item.text);
      }
    }
    return texts.join('\n');
  }

  parseSessionFile(filepath) {
    const messages = [];
    let sessionInfo = null;
    let isCronSession = false;
    let firstUserMessage = null;
    
    try {
      const content = readFileSync(filepath, 'utf-8');
      const lines = content.trim().split('\n');
      
      for (const line of lines) {
        if (!line.trim()) continue;
        
        try {
          const record = JSON.parse(line);
          
          if (record.type === 'session') {
            sessionInfo = {
              id: record.id,
              timestamp: this.parseTimestamp(record.timestamp),
              cwd: record.cwd
            };
          } else if (record.type === 'message' && record.message) {
            const msg = record.message;
            if (msg.role === 'user' || msg.role === 'assistant') {
              const textContent = this.extractTextContent(msg.content);
              if (textContent.trim()) {
                if (msg.role === 'user' && !firstUserMessage) {
                  firstUserMessage = textContent;
                  if (textContent.startsWith('[cron:')) {
                    isCronSession = true;
                  }
                }
                messages.push({
                  id: record.id,
                  sessionId: sessionInfo?.id || basename(filepath, '.jsonl'),
                  timestamp: this.parseTimestamp(record.timestamp) || this.parseTimestamp(msg.timestamp),
                  role: msg.role,
                  content: textContent,
                  filepath: filepath
                });
              }
            }
          }
        } catch (e) {
          // 跳过解析失败的行
        }
      }
    } catch (err) {
      this.options.logger.warn?.(`解析会话文件失败: ${filepath}, ${err.message}`);
    }
    
    return { messages, sessionInfo, isCronSession };
  }

  loadSessionDirectory(sessionDir) {
    if (!existsSync(sessionDir)) {
      this.options.logger.warn?.(`会话目录不存在: ${sessionDir}`);
      return 0;
    }

    this.sessionDir = sessionDir;
    const files = readdirSync(sessionDir);
    let loadedCount = 0;

    for (const file of files) {
      // 支持 .jsonl 和 .deleted.xxx.jsonl（归档文件）
      if (!file.endsWith('.jsonl')) continue;
      // 排除备份和重置文件，但保留归档文件（.deleted.xxx）
      if (file.includes('.bak-') || file.includes('.reset.')) continue;

      const filepath = join(sessionDir, file);
      
      try {
        const stat = statSync(filepath);
        
        if (stat.isDirectory()) continue;
        if (stat.size > MAX_FILE_SIZE) {
          this.options.logger.warn?.(`文件过大，跳过: ${file}`);
          continue;
        }

        const { messages, sessionInfo, isCronSession } = this.parseSessionFile(filepath);
        
        if (sessionInfo) {
          this.sessions.set(sessionInfo.id, {
            ...sessionInfo,
            filepath,
            messageCount: messages.length,
            firstMessageTime: messages.length > 0 ? messages[0].timestamp : null,
            lastMessageTime: messages.length > 0 ? messages[messages.length - 1].timestamp : null,
            isCronSession
          });
        }
        
        for (const msg of messages) {
          this.messages.set(`${msg.sessionId}:${msg.id}`, msg);
          loadedCount++;
        }
      } catch (err) {
        this.options.logger.warn?.(`加载会话失败: ${file}, ${err.message}`);
      }
    }

    this.buildIndex();
    
    return loadedCount;
  }

  buildIndex() {
    this.miniSearch = new MiniSearch({
      fields: ['content'],
      storeFields: ['id', 'sessionId', 'timestamp', 'role', 'content'],
      tokenize: (text) => tokenize(text),
      searchOptions: {
        tokenize: (text) => tokenize(text),
        prefix: true,
        fuzzy: 0.2
      }
    });

    const docs = Array.from(this.messages.values()).map(msg => ({
      id: `${msg.sessionId}:${msg.id}`,
      content: msg.content,
      timestamp: msg.timestamp,
      role: msg.role,
      sessionId: msg.sessionId
    }));
    
    this.miniSearch.addAll(docs);
    
    this.options.logger.info?.(`会话索引构建完成: ${docs.length} 条消息`);
  }

  parseDateFilter(dateStr) {
    if (!dateStr) return null;

    // YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      const [year, month, day] = dateStr.split('-').map(Number);
      const start = new Date(year, month - 1, day);
      const end = new Date(year, month - 1, day, 23, 59, 59);
      return { start: start.getTime(), end: end.getTime() };
    }
    
    // YYYY-MM
    if (/^\d{4}-\d{2}$/.test(dateStr)) {
      const [year, month] = dateStr.split('-').map(Number);
      const start = new Date(year, month - 1, 1);
      const end = new Date(year, month, 0, 23, 59, 59);
      return { start: start.getTime(), end: end.getTime() };
    }

    // 快捷词
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    switch (dateStr) {
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
        const monthAgo = new Date(today);
        monthAgo.setMonth(monthAgo.getMonth() - 1);
        return { start: monthAgo.getTime(), end: Date.now() };
      }
      default: {
        // last_N_days 格式
        const match = dateStr.match(/^last_(\d+)_days?$/);
        if (match) {
          const days = parseInt(match[1], 10);
          const start = new Date(today);
          start.setDate(start.getDate() - days);
          return { start: start.getTime(), end: Date.now() };
        }
        return null;
      }
    }
  }

  listSessionsByDate(dateStr) {
    const timeRange = this.parseDateFilter(dateStr);
    if (!timeRange) {
      return [];
    }

    // 优化：按 sessionId 分组消息，避免嵌套循环 O(n×m) -> O(n+m)
    const messagesBySession = new Map();
    for (const msg of this.messages.values()) {
      if (msg.timestamp >= timeRange.start && msg.timestamp <= timeRange.end) {
        const count = messagesBySession.get(msg.sessionId) || 0;
        messagesBySession.set(msg.sessionId, count + 1);
      }
    }

    const results = [];
    for (const [sessionId, session] of this.sessions) {
      // 过滤 cron 会话
      if (session.isCronSession) continue;
      
      const messagesInRange = messagesBySession.get(sessionId);
      if (messagesInRange) {
        results.push({
          sessionId,
          filepath: session.filepath,
          messageCount: messagesInRange,
          firstMessageTime: session.firstMessageTime,
          lastMessageTime: session.lastMessageTime
        });
      }
    }

    results.sort((a, b) => (a.firstMessageTime || 0) - (b.firstMessageTime || 0));
    
    return results;
  }

  search(query, options = {}) {
    if (!this.miniSearch) {
      return [];
    }

    const { limit = 10, dateFilter = null } = options;
    const timeRange = this.parseDateFilter(dateFilter);

    const rawResults = this.miniSearch.search(query, {
      prefix: true,
      fuzzy: 0.2
    });

    const results = [];

    for (const result of rawResults) {
      const msg = this.messages.get(result.id);
      if (!msg) continue;

      if (timeRange) {
        if (msg.timestamp < timeRange.start || msg.timestamp > timeRange.end) {
          continue;
        }
      }

      results.push({
        ...msg,
        score: result.score,
        matchedText: this.extractMatchedText(msg.content, query)
      });

      if (results.length >= limit) break;
    }

    return results;
  }

  extractMatchedText(content, query, contextLength = 80) {
    const tokens = tokenize(query);
    if (tokens.length === 0) {
      return content.slice(0, contextLength) + (content.length > contextLength ? '...' : '');
    }

    for (const token of tokens) {
      if (!token) continue;
      const index = content.indexOf(token);
      if (index !== -1) {
        const start = Math.max(0, index - 20);
        const end = Math.min(content.length, index + token.length + contextLength - 20);
        let snippet = content.slice(start, end);
        
        if (start > 0) snippet = '...' + snippet;
        if (end < content.length) snippet = snippet + '...';
        
        return snippet;
      }
    }

    return content.slice(0, contextLength) + (content.length > contextLength ? '...' : '');
  }

  exportSession(sessionId, options = {}) {
    const { includeThinking = false, includeToolCalls = false } = options;
    
    // 安全验证：sessionId 只允许字母、数字、连字符和下划线，防止路径注入
    if (!sessionId || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      this.options.logger.warn?.(`无效的 sessionId 格式: ${sessionId}`);
      return null;
    }
    
    // 找到对应的文件（精确匹配或前缀匹配）
    let filepath = null;
    for (const [id, session] of this.sessions) {
      // 安全：只允许精确匹配或有效的UUID前缀匹配
      if (id === sessionId) {
        filepath = session.filepath;
        break;
      }
      // 前缀匹配：确保 sessionId 是有效的 UUID 前缀（至少8个字符）
      if (sessionId.length >= 8 && id.startsWith(sessionId)) {
        filepath = session.filepath;
        break;
      }
    }
    
    if (!filepath) {
      // 尝试直接用 sessionId 作为文件名（已通过正则验证，安全）
      filepath = join(this.sessionDir, `${sessionId}.jsonl`);
      if (!existsSync(filepath)) {
        return null;
      }
    }

    const lines = [];
    
    try {
      const content = readFileSync(filepath, 'utf-8');
      const records = content.trim().split('\n');
      
      for (const line of records) {
        if (!line.trim()) continue;
        
        try {
          const record = JSON.parse(line);
          
          if (record.type === 'message' && record.message) {
            const msg = record.message;
            if (msg.role === 'user' || msg.role === 'assistant') {
              // 提取文本内容
              const textParts = [];
              if (Array.isArray(msg.content)) {
                for (const item of msg.content) {
                  if (item.type === 'text' && item.text) {
                    textParts.push(item.text);
                  } else if (item.type === 'thinking' && includeThinking && item.thinking) {
                    textParts.push(`[思考] ${item.thinking}`);
                  } else if (item.type === 'toolCall' && includeToolCalls) {
                    textParts.push(`[工具调用] ${item.toolCallId || ''}`);
                  }
                }
              }
              
              const text = textParts.join('\n');
              
              // 过滤心跳消息
              if (msg.role === 'user' && text.startsWith('Read HEARTBEAT.md')) {
                continue;
              }
              
              if (text.trim()) {
                const timestamp = this.parseTimestamp(record.timestamp) || this.parseTimestamp(msg.timestamp);
                const date = new Date(timestamp);
                const timeStr = date.toLocaleString('zh-CN', {
                  year: 'numeric',
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit'
                });
                
                const roleLabel = msg.role === 'user' ? '用户' : '小布';
                
                lines.push({
                  time: timeStr,
                  role: roleLabel,
                  content: text
                });
              }
            }
          }
        } catch (e) {
          // 跳过解析失败的行
        }
      }
    } catch (err) {
      this.options.logger.warn?.(`导出会话失败: ${err.message}`);
      return null;
    }

    return lines;
  }

  formatSessionExport(lines) {
    if (!lines || lines.length === 0) {
      return '会话为空';
    }

    const output = [];
    for (const line of lines) {
      output.push(`【${line.time}】${line.role}：`);
      output.push(line.content);
      output.push('');
    }
    
    return output.join('\n');
  }

  formatDate(timestamp) {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hour}:${minute}`;
  }

  getStats() {
    // 使用 reduce 避免创建临时大数组，提升性能
    const timestamps = Array.from(this.messages.values(), m => m.timestamp);
    
    let oldestMessage = null;
    let newestMessage = null;
    
    if (timestamps.length > 0) {
      oldestMessage = timestamps.reduce((min, ts) => ts < min ? ts : min, timestamps[0]);
      newestMessage = timestamps.reduce((max, ts) => ts > max ? ts : max, timestamps[0]);
    }
    
    return {
      sessionCount: this.sessions.size,
      messageCount: this.messages.size,
      oldestMessage,
      newestMessage
    };
  }
}

export default SessionSearchEngine;
