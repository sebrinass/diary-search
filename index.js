/**
 * OpenClaw Diary Search Plugin
 * 
 * 基于 MiniSearch 的日记全文检索插件
 * 支持：BM25 检索、中文分词、时间衰减排序、同义词扩展、工作区隔离
 */

import { existsSync, readFileSync, realpathSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname, normalize, resolve, basename, isAbsolute, relative as pathRelative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DiarySearchEngine } from './search.js';
import { SessionSearchEngine } from './session.js';
import { CronSearchEngine } from './cron.js';

// 获取当前模块目录
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 展开路径中的 ~ 符号为用户主目录
 * @param {string} inputPath - 可能包含 ~ 的路径
 * @returns {string} 展开后的路径
 */
function expandTilde(inputPath) {
  if (typeof inputPath === 'string' && inputPath.startsWith('~')) {
    return inputPath.replace('~', process.env.HOME || process.env.USERPROFILE || '');
  }
  return inputPath;
}

/**
 * 安全地解析和验证路径，防止路径遍历攻击
 * @param {string} inputPath - 用户输入的路径
 * @param {string} basePath - 基础路径（用于相对路径解析）
 * @param {Object} logger - 日志记录器
 * @returns {{valid: boolean, path: string, error?: string}} 验证结果
 */
function safeResolvePath(inputPath, basePath, logger) {
  try {
    if (isAbsolute(inputPath)) {
      logger.warn?.(`拒绝绝对路径输入: ${inputPath}`);
      return { valid: false, path: inputPath, error: '不允许使用绝对路径' };
    }

    const normalizedBase = normalize(basePath);
    const resolvedPath = resolve(normalizedBase, inputPath);
    
    if (!existsSync(resolvedPath)) {
      return { valid: false, path: resolvedPath, error: `路径不存在: ${resolvedPath}` };
    }
    
    const realPath = realpathSync(resolvedPath);
    const realBase = realpathSync(normalizedBase);
    
    const rel = pathRelative(realBase, realPath);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      logger.warn?.(`检测到路径遍历尝试: ${inputPath} -> ${realPath}`);
      return { valid: false, path: realPath, error: '路径不在允许的范围内' };
    }
    
    return { valid: true, path: resolvedPath };
  } catch (err) {
    return { valid: false, path: inputPath, error: `路径解析失败: ${err.message}` };
  }
}

/**
 * 验证 agent 名称，防止路径遍历攻击
 * @param {string} agent - Agent 名称
 * @returns {{valid: boolean, error?: string}} 验证结果
 */
function validateAgentName(agent) {
  if (!agent || typeof agent !== 'string') {
    return { valid: false, error: 'Agent 名称无效' };
  }
  
  // 只允许字母、数字、下划线、连字符（regex 已防止路径遍历）
  if (!/^[a-zA-Z0-9_-]+$/.test(agent)) {
    return { valid: false, error: 'Agent 名称只能包含字母、数字、下划线和连字符' };
  }
  
  return { valid: true };
}

/**
 * 验证会话ID，防止路径遍历攻击
 * @param {string} sessionId - 会话ID
 * @returns {{valid: boolean, error?: string}} 验证结果
 */
function validateSessionId(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') {
    return { valid: false, error: '会话ID无效' };
  }
  
  // 会话ID通常是UUID格式，允许字母、数字、连字符（regex 已防止路径遍历）
  if (!/^[a-zA-Z0-9-]+$/.test(sessionId)) {
    return { valid: false, error: '会话ID只能包含字母、数字和连字符' };
  }
  
  return { valid: true };
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG = {
  enabled: true,
  defaultWorkspace: '~/.openclaw',
  stateDir: '~/.openclaw',
  diarySubdir: 'memory',
  defaultLimit: 5,
  defaultSessionDays: 30,
  timeDecayFactor: 0.1,
  synonymsPath: './synonyms.json',
  exportMaxAgeDays: 3
};

/**
 * 搜索引擎实例缓存（按工作区隔离）
 * @type {Map<string, DiarySearchEngine>}
 */
const engineCache = new Map();

/**
 * 会话搜索引擎实例缓存
 * @type {Map<string, SessionSearchEngine>}
 */
const sessionEngineCache = new Map();

/**
 * 定时任务搜索引擎实例缓存
 * @type {Map<string, CronSearchEngine>}
 */
const cronEngineCache = new Map();

/**
 * 加载同义词字典
 * @param {string} synonymsPath - 同义词文件路径
 * @returns {Object} 同义词字典
 */
function loadSynonyms(synonymsPath) {
  try {
    if (existsSync(synonymsPath)) {
      const content = readFileSync(synonymsPath, 'utf-8');
      return JSON.parse(content);
    }
  } catch (err) {
    // 同义词字典加载失败不影响核心功能
  }
  return {};
}

/**
 * 获取或创建搜索引擎实例
 * @param {string} diaryDir - 日记目录
 * @param {Object} options - 配置选项
 * @returns {DiarySearchEngine} 搜索引擎实例
 */
function getOrCreateEngine(diaryDir, options) {
  // 检查缓存
  let engine = engineCache.get(diaryDir);
  
  if (!engine) {
    engine = new DiarySearchEngine({
      timeDecayFactor: options.timeDecayFactor,
      synonyms: options.synonyms,
      logger: options.logger
    });
    
    const count = engine.loadDiaryDirectory(diaryDir);
    options.logger.info?.(`日记搜索引擎初始化: ${diaryDir}, 加载 ${count} 篇日记`);
    
    engineCache.set(diaryDir, engine);
  }
  
  return engine;
}

/**
 * 获取或创建会话搜索引擎实例
 * @param {string} sessionDir - 会话目录
 * @param {Object} options - 配置选项
 * @returns {SessionSearchEngine} 会话搜索引擎实例
 */
function getOrCreateSessionEngine(sessionDir, options) {
  let engine = sessionEngineCache.get(sessionDir);
  
  if (!engine) {
    engine = new SessionSearchEngine({
      timeDecayFactor: options.timeDecayFactor,
      logger: options.logger
    });
    
    const count = engine.loadSessionDirectory(sessionDir);
    options.logger.info?.(`会话搜索引擎初始化: ${sessionDir}, 加载 ${count} 条消息`);
    
    sessionEngineCache.set(sessionDir, engine);
  }
  
  return engine;
}

/**
 * 获取或创建定时任务搜索引擎实例
 * @param {string} cronDir - 定时任务目录
 * @param {Object} options - 配置选项
 * @returns {CronSearchEngine} 定时任务搜索引擎实例
 */
function getOrCreateCronEngine(cronDir, options) {
  let engine = cronEngineCache.get(cronDir);
  
  if (!engine) {
    engine = new CronSearchEngine(cronDir, {
      logger: options.logger
    });
    
    engine.load();
    options.logger.info?.(`定时任务搜索引擎初始化: ${cronDir}`);
    
    cronEngineCache.set(cronDir, engine);
  }
  
  return engine;
}

/**
 * 插件定义
 */
const diarySearchPlugin = {
  id: 'diary-search',
  name: 'Diary Search',
  description: '基于 MiniSearch 的日记全文检索插件，支持中文分词和时间衰减排序',
  kind: 'extension',

  /**
   * 注册插件
   * @param {Object} api - OpenClaw 插件 API
   */
  register(api) {
    // 合并配置
    const config = { ...DEFAULT_CONFIG, ...api.pluginConfig };
    
    // 解析路径
    const synonymsPath = join(__dirname, config.synonymsPath);
    const synonyms = loadSynonyms(synonymsPath);
    
    api.logger.info(`diary-search: 插件注册`);
    api.logger.info(`diary-search: 同义词数量: ${Object.keys(synonyms).length}`);
    
    if (!config.enabled) {
      api.logger.info('diary-search: 插件已禁用');
      return;
    }

    // 注册 diary_search 工具
    api.registerTool(
      {
        name: 'diary_search',
        label: 'Diary Search',
        description: 
          '搜索日记内容。支持中文分词、时间过滤和工作区隔离。' +
          '使用 BM25 算法进行相关性排序，并应用时间衰减（近期日记优先）。',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '搜索关键词，支持中英文混合'
            },
            limit: {
              type: 'number',
              description: `返回条数，默认 ${config.defaultLimit}`
            },
            time_filter: {
              type: 'string',
              description: 
                '时间过滤器。可选值: today, yesterday, last_week, last_month, this_month, ' +
                '或具体日期格式 YYYY-MM, YYYY-MM-DD'
            },
            workspace: {
              type: 'string',
              description: 
                '工作区路径（可选）。用于多 agent 隔离，不同工作区有独立的日记目录。' +
                `默认使用配置的工作区: ${config.defaultWorkspace}`
            }
          },
          required: ['query']
        },
        
        /**
         * 执行搜索
         * @param {string} _toolCallId - 工具调用 ID
         * @param {Object} params - 参数
         * @returns {Object} 搜索结果
         */
        async execute(_toolCallId, params) {
          const { 
            query, 
            limit = config.defaultLimit, 
            time_filter = null,
            workspace = null 
          } = params;
          
          if (!query || query.trim().length === 0) {
            return {
              content: [{ type: 'text', text: '请提供搜索关键词。' }],
              details: { error: 'empty_query' }
            };
          }

          // 验证 limit 参数
          const safeLimit = Math.max(1, Math.min(100, Number(limit) || config.defaultLimit));

          try {
            // 确定基础路径（使用默认工作区作为基础）
            const basePath = api.resolvePath(config.defaultWorkspace);
            
            // 安全地解析工作区路径
            let workspacePath;
            if (workspace) {
              const pathResult = safeResolvePath(workspace, basePath, api.logger);
              if (!pathResult.valid) {
                return {
                  content: [{ type: 'text', text: `工作区路径无效: ${pathResult.error}` }],
                  details: { error: 'invalid_workspace', path: workspace }
                };
              }
              workspacePath = pathResult.path;
            } else {
              workspacePath = basePath;
            }
            
            // 日记目录
            const diaryDir = join(workspacePath, config.diarySubdir);
            
            // 获取搜索引擎
            const engine = getOrCreateEngine(diaryDir, {
              timeDecayFactor: config.timeDecayFactor,
              synonyms,
              logger: api.logger
            });
            
            // 执行搜索
            const results = engine.search(query, {
              limit: safeLimit,
              timeFilter: time_filter,
              timeDecay: true
            });
            
            // 格式化输出
            const markdown = engine.formatResultsAsMarkdown(results);
            
            return {
              content: [{ type: 'text', text: markdown }],
              details: {
                query,
                workspace: workspacePath,
                diaryDir,
                resultCount: results.length,
                results: results.map(r => ({
                  id: r.id,
                  title: r.title,
                  score: r.score,
                  finalScore: r.finalScore,
                  timestamp: r.timestamp
                }))
              }
            };
          } catch (err) {
            api.logger.error(`diary-search: 搜索失败: ${err.message}`);
            return {
              content: [{ type: 'text', text: `搜索失败: ${err.message}` }],
              details: { error: err.message }
            };
          }
        }
      },
      { name: 'diary_search' }
    );

    // 注册 diary_stats 工具（辅助工具）
    api.registerTool(
      {
        name: 'diary_stats',
        label: 'Diary Statistics',
        description: '获取日记统计信息，包括文档数量、最早和最新日记日期。',
        parameters: {
          type: 'object',
          properties: {
            workspace: {
              type: 'string',
              description: '工作区路径（可选）'
            }
          }
        },
        
        async execute(_toolCallId, params) {
          const { workspace = null } = params;
          
          try {
            // 确定基础路径
            const basePath = api.resolvePath(config.defaultWorkspace);
            
            // 安全地解析工作区路径
            let workspacePath;
            if (workspace) {
              const pathResult = safeResolvePath(workspace, basePath, api.logger);
              if (!pathResult.valid) {
                return {
                  content: [{ type: 'text', text: `工作区路径无效: ${pathResult.error}` }],
                  details: { error: 'invalid_workspace', path: workspace }
                };
              }
              workspacePath = pathResult.path;
            } else {
              workspacePath = basePath;
            }
            
            const diaryDir = join(workspacePath, config.diarySubdir);
            const engine = getOrCreateEngine(diaryDir, {
              timeDecayFactor: config.timeDecayFactor,
              synonyms,
              logger: api.logger
            });
            
            const stats = engine.getStats();
            
            const lines = [
              '## 日记统计',
              '',
              `- **文档数量**: ${stats.documentCount} 篇`
            ];
            
            if (stats.oldestDocument) {
              const oldest = new Date(stats.oldestDocument);
              lines.push(`- **最早日记**: ${oldest.toISOString().split('T')[0]}`);
            }
            
            if (stats.newestDocument) {
              const newest = new Date(stats.newestDocument);
              lines.push(`- **最新日记**: ${newest.toISOString().split('T')[0]}`);
            }
            
            lines.push(`- **日记目录**: ${diaryDir}`);
            
            return {
              content: [{ type: 'text', text: lines.join('\n') }],
              details: { ...stats, diaryDir }
            };
          } catch (err) {
            return {
              content: [{ type: 'text', text: `获取统计失败: ${err.message}` }],
              details: { error: err.message }
            };
          }
        }
      },
      { name: 'diary_stats' }
    );

    // 注册 session_list_by_date 工具
    api.registerTool(
      {
        name: 'session_list_by_date',
        label: 'Session List by Date',
        description: 
          '按日期列出会话文件。返回当天有消息的所有会话文件及其统计信息。' +
          '适用于查看某天有哪些对话，方便写日记时回顾。',
        parameters: {
          type: 'object',
          properties: {
            date: {
              type: 'string',
              description: 
                '日期。可选值: today, yesterday, last_week, last_month, ' +
                '或具体日期格式 YYYY-MM-DD, YYYY-MM'
            },
            agent: {
              type: 'string',
              description: 'Agent 名称，默认 xiaobu'
            }
          },
          required: ['date']
        },
        
        async execute(_toolCallId, params) {
          const { date, agent = 'xiaobu' } = params;
          
          if (!date) {
            return {
              content: [{ type: 'text', text: '请提供日期参数。' }],
              details: { error: 'missing_date' }
            };
          }
          
          // 验证 agent 名称
          const agentValidation = validateAgentName(agent);
          if (!agentValidation.valid) {
            return {
              content: [{ type: 'text', text: `Agent 名称无效: ${agentValidation.error}` }],
              details: { error: 'invalid_agent' }
            };
          }
          
          try {
            const stateDir = api.resolvePath(config.stateDir || config.defaultWorkspace);
            const sessionDir = join(stateDir, 'agents', agent, 'sessions');
            
            const engine = getOrCreateSessionEngine(sessionDir, {
              timeDecayFactor: config.timeDecayFactor,
              logger: api.logger
            });
            
            const sessions = engine.listSessionsByDate(date);
            
            if (sessions.length === 0) {
              return {
                content: [{ type: 'text', text: `没有找到 ${date} 的会话记录。` }],
                details: { date, sessionDir }
              };
            }
            
            const lines = [
              `## ${date} 的会话列表`,
              '',
              '| 会话ID | 消息数 | 首条消息 | 末条消息 |',
              '|--------|--------|----------|----------|'
            ];
            
            for (const session of sessions) {
              const shortId = session.sessionId.slice(0, 8) + '...';
              const firstTime = session.firstMessageTime ? engine.formatDate(session.firstMessageTime) : '-';
              const lastTime = session.lastMessageTime ? engine.formatDate(session.lastMessageTime) : '-';
              lines.push(`| ${shortId} | ${session.messageCount} | ${firstTime} | ${lastTime} |`);
            }
            
            lines.push('');
            lines.push(`共 ${sessions.length} 个会话，${sessions.reduce((sum, s) => sum + s.messageCount, 0)} 条消息。`);
            
            return {
              content: [{ type: 'text', text: lines.join('\n') }],
              details: { date, sessionCount: sessions.length, sessions }
            };
          } catch (err) {
            api.logger.error(`session-list: 列出会话失败: ${err.message}`);
            return {
              content: [{ type: 'text', text: `列出会话失败: ${err.message}` }],
              details: { error: err.message }
            };
          }
        }
      },
      { name: 'session_list_by_date' }
    );

    // 注册 session_search 工具
    api.registerTool(
      {
        name: 'session_search',
        label: 'Session Search',
        description: 
          `搜索会话消息内容。支持中文分词和时间过滤。` +
          `默认搜索最近 ${config.defaultSessionDays} 天的会话，如需搜索更早内容请指定 date 参数。` +
          `返回匹配的消息片段，适用于查找具体对话内容。`,
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '搜索关键词，支持中英文混合'
            },
            date: {
              type: 'string',
              description: 
                `日期过滤（可选）。默认最近 ${config.defaultSessionDays} 天。` +
                `可选值: today, yesterday, last_week, last_month, 或具体日期格式 YYYY-MM-DD, YYYY-MM。` +
                `如搜不到内容，可尝试扩大时间范围。`
            },
            limit: {
              type: 'number',
              description: `返回条数，默认 ${config.defaultLimit}`
            },
            agent: {
              type: 'string',
              description: 'Agent 名称，默认 xiaobu'
            }
          },
          required: ['query']
        },
        
        async execute(_toolCallId, params) {
          const { query, date = `last_${config.defaultSessionDays}_days`, limit = config.defaultLimit, agent = 'xiaobu' } = params;
          
          if (!query || query.trim().length === 0) {
            return {
              content: [{ type: 'text', text: '请提供搜索关键词。' }],
              details: { error: 'empty_query' }
            };
          }
          
          // 验证 agent 名称
          const agentValidation = validateAgentName(agent);
          if (!agentValidation.valid) {
            return {
              content: [{ type: 'text', text: `Agent 名称无效: ${agentValidation.error}` }],
              details: { error: 'invalid_agent' }
            };
          }
          
          const safeLimit = Math.max(1, Math.min(100, Number(limit) || config.defaultLimit));
          
          try {
            const stateDir = api.resolvePath(config.stateDir || config.defaultWorkspace);
            const sessionDir = join(stateDir, 'agents', agent, 'sessions');
            
            const engine = getOrCreateSessionEngine(sessionDir, {
              timeDecayFactor: config.timeDecayFactor,
              logger: api.logger
            });
            
            const results = engine.search(query, {
              limit: safeLimit,
              dateFilter: date
            });
            
            if (results.length === 0) {
              const dateHint = date ? ` (${date})` : '';
              return {
                content: [{ type: 'text', text: `没有找到匹配"${query}"的消息${dateHint}。` }],
                details: { query, date }
              };
            }
            
            const lines = ['## 会话搜索结果', ''];
            
            for (const result of results) {
              const timeStr = engine.formatDate(result.timestamp);
              const roleLabel = result.role === 'user' ? '用户' : '小布';
              lines.push(`### ${timeStr} (${roleLabel})`);
              lines.push(`> ${result.matchedText.replace(/\n/g, '\n> ')}`);
              lines.push(`*会话: ${result.sessionId.slice(0, 8)}...*`);
              lines.push('');
            }
            
            return {
              content: [{ type: 'text', text: lines.join('\n') }],
              details: {
                query,
                date,
                resultCount: results.length,
                results: results.map(r => ({
                  sessionId: r.sessionId,
                  timestamp: r.timestamp,
                  role: r.role,
                  score: r.score
                }))
              }
            };
          } catch (err) {
            api.logger.error(`session-search: 搜索失败: ${err.message}`);
            return {
              content: [{ type: 'text', text: `搜索失败: ${err.message}` }],
              details: { error: err.message }
            };
          }
        }
      },
      { name: 'session_search' }
    );

    // 注册 session_export 工具
    api.registerTool(
      {
        name: 'session_export',
        label: 'Session Export',
        description: 
          '导出会话的纯对话文本。过滤掉工具调用和思考过程，只保留用户和助手的对话内容。' +
          '适用于查看完整对话记录，方便写日记或回顾。',
        parameters: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: '会话ID（可以是完整ID或前缀）'
            },
            agent: {
              type: 'string',
              description: 'Agent 名称，默认 xiaobu'
            },
            include_thinking: {
              type: 'boolean',
              description: '是否包含 AI 思考过程，默认 false'
            }
          },
          required: ['session_id']
        },
        
        async execute(_toolCallId, params) {
          const { session_id, agent = 'xiaobu', include_thinking = false } = params;
          
          if (!session_id) {
            return {
              content: [{ type: 'text', text: '请提供会话ID。' }],
              details: { error: 'missing_session_id' }
            };
          }
          
          // 验证 agent 名称
          const agentValidation = validateAgentName(agent);
          if (!agentValidation.valid) {
            return {
              content: [{ type: 'text', text: `Agent 名称无效: ${agentValidation.error}` }],
              details: { error: 'invalid_agent' }
            };
          }
          
          // 验证会话ID
          const sessionIdValidation = validateSessionId(session_id);
          if (!sessionIdValidation.valid) {
            return {
              content: [{ type: 'text', text: `会话ID无效: ${sessionIdValidation.error}` }],
              details: { error: 'invalid_session_id' }
            };
          }
          
          try {
            const stateDir = api.resolvePath(config.stateDir || config.defaultWorkspace);
            const sessionDir = join(stateDir, 'agents', agent, 'sessions');
            
            const engine = getOrCreateSessionEngine(sessionDir, {
              timeDecayFactor: config.timeDecayFactor,
              logger: api.logger
            });
            
            const lines = engine.exportSession(session_id, { includeThinking: include_thinking });

            if (!lines || lines.length === 0) {
              return {
                content: [{ type: 'text', text: `没有找到会话 ${session_id}，或会话为空。` }],
                details: { sessionId: session_id }
              };
            }

            const workspacePath = api.resolvePath(config.defaultWorkspace);
            const exportDir = join(workspacePath, config.diarySubdir, 'exports');
            const savedPath = engine.saveSessionExport(lines, exportDir, session_id, config.exportMaxAgeDays ?? 3);

            const markdown = engine.formatSessionExportWithMetadata(lines, session_id, config.exportMaxAgeDays ?? 3);

            return {
              content: [{ type: 'text', text: markdown }],
              details: {
                sessionId: session_id,
                messageCount: lines.length,
                savedPath: savedPath
              }
            };
          } catch (err) {
            api.logger.error(`session-export: 导出失败: ${err.message}`);
            return {
              content: [{ type: 'text', text: `导出会话失败: ${err.message}` }],
              details: { error: err.message }
            };
          }
        }
      },
      { name: 'session_export' }
    );

    // 注册 cron_list_runs 工具
    api.registerTool(
      {
        name: 'cron_list_runs',
        label: 'Cron List Runs',
        description: 
          '列出定时任务的运行记录。' +
          '返回任务名称、运行时间、状态、摘要等信息，可用于查看定时任务执行情况。',
        parameters: {
          type: 'object',
          properties: {
            days: {
              type: 'number',
              description: '查询最近多少天的记录，默认 7 天'
            },
            agent: {
              type: 'string',
              description: '过滤指定 agent 的定时任务（可选）'
            }
          }
        },
        
        async execute(_toolCallId, params) {
          const { days = 7, agent = null } = params;
          
          const safeDays = Math.max(1, Math.min(365, Number(days) || 7));
          
          // 验证 agent 名称（如果提供了）
          if (agent) {
            const agentValidation = validateAgentName(agent);
            if (!agentValidation.valid) {
              return {
                content: [{ type: 'text', text: `Agent 名称无效: ${agentValidation.error}` }],
                details: { error: 'invalid_agent' }
              };
            }
          }
          
          try {
            const cronDir = join(api.resolvePath(config.stateDir || config.defaultWorkspace), 'cron');
            
            const engine = getOrCreateCronEngine(cronDir, {
              logger: api.logger
            });
            
            const results = engine.listRuns({ days: safeDays, agent });
            
            if (results.length === 0) {
              return {
                content: [{ type: 'text', text: `最近 ${safeDays} 天内没有定时任务运行记录。` }],
                details: { days: safeDays, agent }
              };
            }
            
            // 格式化输出
            const lines = results.map(r => {
              const duration = r.duration ? `${r.duration}秒` : '-';
              const summary = r.summary ? `\n    摘要: ${r.summary}` : '';
              return `## ${r.time} | ${r.jobName}\n` +
                     `    状态: ${r.status} | 耗时: ${duration} | Agent: ${r.agent}\n` +
                     `    会话ID: ${r.sessionId}${summary}`;
            });
            
            return {
              content: [{ type: 'text', text: `找到 ${results.length} 条定时任务运行记录：\n\n${lines.join('\n\n')}` }],
              details: { count: results.length, days: safeDays, agent }
            };
          } catch (err) {
            return {
              content: [{ type: 'text', text: `查询定时任务失败: ${err.message}` }],
              details: { error: err.message }
            };
          }
        }
      },
      { name: 'cron_list_runs' }
    );

    // 注册 diary_cleanup 工具
    api.registerTool(
      {
        name: 'diary_cleanup',
        label: 'Diary Cleanup',
        description:
          '扫描并清理会话目录中的 checkpoint 备份文件。' +
          'checkpoint 文件是 OpenClaw 在会话出错/中断时自动创建的快照，内容与原会话完全重复。' +
          '⚠️ 删除前必须向用户确认！先调用 dry_run=true 查看将删除的文件，用户确认后再执行删除。',
        parameters: {
          type: 'object',
          properties: {
            agent: {
              type: 'string',
              description: 'Agent 名称，默认 xiaobu'
            },
            dry_run: {
              type: 'boolean',
              description: '仅扫描不删除（默认 true）。设为 false 时才会实际删除文件，但必须先向用户确认！'
            }
          }
        },

        async execute(_toolCallId, params) {
          const { agent = 'xiaobu', dry_run = true } = params;

          const agentValidation = validateAgentName(agent);
          if (!agentValidation.valid) {
            return {
              content: [{ type: 'text', text: `Agent 名称无效: ${agentValidation.error}` }],
              details: { error: 'invalid_agent' }
            };
          }

          if (!dry_run) {
            try {
              const stateDir = api.resolvePath(config.stateDir || config.defaultWorkspace);
              const sessionDir = join(stateDir, 'agents', agent, 'sessions');

              if (!existsSync(sessionDir)) {
                return {
                  content: [{ type: 'text', text: `会话目录不存在: ${sessionDir}` }],
                  details: { error: 'dir_not_found' }
                };
              }

              const files = readdirSync(sessionDir);
              let deleted = 0;
              let freedBytes = 0;
              const errors = [];

              for (const file of files) {
                if (!file.includes('.checkpoint.') || !file.endsWith('.jsonl')) continue;
                const filepath = join(sessionDir, file);
                try {
                  const stat = statSync(filepath);
                  unlinkSync(filepath);
                  deleted++;
                  freedBytes += stat.size;
                } catch (err) {
                  errors.push({ file, error: err.message });
                }
              }

              const freedMB = (freedBytes / 1024 / 1024).toFixed(2);
              const msg = errors.length === 0
                ? `✅ 已清理 ${deleted} 个 checkpoint 文件，释放 ${freedMB}MB 空间。`
                : `✅ 已清理 ${deleted} 个 checkpoint 文件，释放 ${freedMB}MB 空间。${errors.length} 个文件删除失败。`;

              sessionEngineCache.delete(sessionDir);

              return {
                content: [{ type: 'text', text: msg }],
                details: { agent, deleted, freedMB, errors }
              };
            } catch (err) {
              return {
                content: [{ type: 'text', text: `清理失败: ${err.message}` }],
                details: { error: err.message }
              };
            }
          }

          try {
            const stateDir = api.resolvePath(config.stateDir || config.defaultWorkspace);
            const sessionDir = join(stateDir, 'agents', agent, 'sessions');

            if (!existsSync(sessionDir)) {
              return {
                content: [{ type: 'text', text: `会话目录不存在: ${sessionDir}` }],
                details: { error: 'dir_not_found' }
              };
            }

            const files = readdirSync(sessionDir);
            const checkpoints = [];

            for (const file of files) {
              if (!file.includes('.checkpoint.')) continue;
              if (!file.endsWith('.jsonl')) continue;

              const filepath = join(sessionDir, file);
              try {
                const stat = statSync(filepath);
                checkpoints.push({
                  filename: file,
                  size: stat.size,
                  sizeMB: (stat.size / 1024 / 1024).toFixed(2),
                  modified: stat.mtime.toISOString().split('T')[0]
                });
              } catch (err) {
                checkpoints.push({
                  filename: file,
                  size: 0,
                  sizeMB: '0.00',
                  modified: 'unknown',
                  error: err.message
                });
              }
            }

            if (checkpoints.length === 0) {
              return {
                content: [{ type: 'text', text: `✅ ${agent} 的会话目录中没有 checkpoint 文件，无需清理。` }],
                details: { agent, checkpointCount: 0 }
              };
            }

            const totalSize = checkpoints.reduce((sum, c) => sum + c.size, 0);
            const totalSizeMB = (totalSize / 1024 / 1024).toFixed(2);

            const lines = [
              `## Checkpoint 扫描结果 (${agent})`,
              '',
              `发现 **${checkpoints.length}** 个 checkpoint 文件，共 **${totalSizeMB}MB**`,
              '',
              '| 文件名 | 大小 | 修改日期 |',
              '|--------|------|----------|'
            ];

            for (const cp of checkpoints) {
              const shortName = cp.filename.length > 50
                ? cp.filename.slice(0, 20) + '...' + cp.filename.slice(-25)
                : cp.filename;
              lines.push(`| ${shortName} | ${cp.sizeMB}MB | ${cp.modified} |`);
            }

            lines.push('');
            lines.push(`💡 如需清理，请确认后调用：\`diary_cleanup(agent="${agent}", dry_run=false)\``);
            lines.push('');
            lines.push('> ⚠️ checkpoint 是会话快照备份，内容与原会话完全重复。删除后不影响正常对话记录。');

            return {
              content: [{ type: 'text', text: lines.join('\n') }],
              details: {
                agent,
                checkpointCount: checkpoints.length,
                totalSizeMB,
                checkpoints
              }
            };
          } catch (err) {
            api.logger.error(`diary-cleanup: 扫描失败: ${err.message}`);
            return {
              content: [{ type: 'text', text: `扫描失败: ${err.message}` }],
              details: { error: err.message }
            };
          }
        }
      },
      { name: 'diary_cleanup' }
    );

    // 注册后台服务（用于清理缓存等）
    api.registerService({
      id: 'diary-search',
      start(ctx) {
        api.logger.info('diary-search: 服务启动');

        if (this._cleanupTimer) {
          clearInterval(this._cleanupTimer);
          this._cleanupTimer = null;
        }

        const workspacePath = api.resolvePath(expandTilde(config.defaultWorkspace));
        const exportDir = join(workspacePath, config.diarySubdir, 'exports');
        const maxAgeDays = config.exportMaxAgeDays ?? 3;

        SessionSearchEngine.cleanupExpiredExports(exportDir, api.logger, maxAgeDays);

        this._cleanupTimer = setInterval(() => {
          try {
            SessionSearchEngine.cleanupExpiredExports(exportDir, api.logger, maxAgeDays);
          } catch (err) {
            api.logger.warn?.(`diary-search: 清理导出文件异常: ${err.message}`);
          }
        }, 24 * 60 * 60 * 1000);

        api.logger.info(`diary-search: 导出文件自动清理已启动，有效期${maxAgeDays}天`);
      },
      stop() {
        if (this._cleanupTimer) {
          clearInterval(this._cleanupTimer);
          this._cleanupTimer = null;
        }

        engineCache.clear();
        sessionEngineCache.clear();
        cronEngineCache.clear();
        api.logger.info('diary-search: 服务停止，缓存已清理');
      }
    });
  }
};

export default diarySearchPlugin;
