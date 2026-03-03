/**
 * OpenClaw Diary Search Plugin
 * 
 * 基于 MiniSearch 的日记全文检索插件
 * 支持：BM25 检索、中文分词、时间衰减排序、同义词扩展、工作区隔离
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, dirname, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DiarySearchEngine } from './search.js';

// 获取当前模块目录
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 安全地解析和验证路径，防止路径遍历攻击
 * @param {string} inputPath - 用户输入的路径
 * @param {string} basePath - 基础路径（用于相对路径解析）
 * @param {Object} logger - 日志记录器
 * @returns {{valid: boolean, path: string, error?: string}} 验证结果
 */
function safeResolvePath(inputPath, basePath, logger) {
  try {
    // 规范化路径，移除 ../ 和 ./ 等
    const normalizedBase = normalize(basePath);
    const resolvedPath = resolve(normalizedBase, inputPath);
    
    // 检查路径是否存在
    if (!existsSync(resolvedPath)) {
      return { valid: false, path: resolvedPath, error: `路径不存在: ${resolvedPath}` };
    }
    
    // 获取真实路径（解析符号链接）
    const realPath = realpathSync(resolvedPath);
    const realBase = realpathSync(normalizedBase);
    
    // 验证解析后的路径仍在基础路径下
    if (!realPath.startsWith(realBase)) {
      logger.warn?.(`检测到路径遍历尝试: ${inputPath} -> ${realPath}`);
      return { valid: false, path: realPath, error: '路径不在允许的范围内' };
    }
    
    return { valid: true, path: resolvedPath };
  } catch (err) {
    return { valid: false, path: inputPath, error: `路径解析失败: ${err.message}` };
  }
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG = {
  enabled: true,
  defaultWorkspace: '~/.openclaw',
  diarySubdir: 'memory',
  defaultLimit: 5,
  timeDecayFactor: 0.1,
  synonymsPath: './synonyms.json'
};

/**
 * 搜索引擎实例缓存（按工作区隔离）
 * @type {Map<string, DiarySearchEngine>}
 */
const engineCache = new Map();

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
    console.warn(`加载同义词字典失败: ${err.message}`);
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

    // 注册后台服务（用于清理缓存等）
    api.registerService({
      id: 'diary-search',
      start() {
        api.logger.info('diary-search: 服务启动');
      },
      stop() {
        // 清理缓存
        engineCache.clear();
        api.logger.info('diary-search: 服务停止，缓存已清理');
      }
    });
  }
};

export default diarySearchPlugin;
