import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

export class CronSearchEngine {
  constructor(cronDir, options = {}) {
    this.cronDir = cronDir;
    this.runsDir = join(cronDir, 'runs');
    this.jobsFile = join(cronDir, 'jobs.json');
    this.options = options;
    this.jobs = new Map();
    this.runs = [];
  }

  load() {
    this.loadJobs();
    this.loadRuns();
  }

  loadJobs() {
    if (!existsSync(this.jobsFile)) {
      this.options.logger?.warn?.(`定时任务配置文件不存在: ${this.jobsFile}`);
      return;
    }

    try {
      const content = readFileSync(this.jobsFile, 'utf-8');
      const data = JSON.parse(content);
      
      if (data.jobs && Array.isArray(data.jobs)) {
        for (const job of data.jobs) {
          this.jobs.set(job.id, job);
        }
      }
      
      this.options.logger?.info?.(`加载了 ${this.jobs.size} 个定时任务配置`);
    } catch (err) {
      this.options.logger?.warn?.(`加载定时任务配置失败: ${err.message}`);
    }
  }

  loadRuns() {
    if (!existsSync(this.runsDir)) {
      this.options.logger?.warn?.(`定时任务运行目录不存在: ${this.runsDir}`);
      return;
    }

    try {
      const files = readdirSync(this.runsDir);
      
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        
        const filepath = join(this.runsDir, file);
        const content = readFileSync(filepath, 'utf-8');
        const lines = content.trim().split('\n');
        
        for (const line of lines) {
          if (!line.trim()) continue;
          
          try {
            const record = JSON.parse(line);
            if (record.action === 'finished') {
              this.runs.push(record);
            }
          } catch (e) {
            // 跳过解析失败的行
          }
        }
      }
      
      // 按时间戳降序排序
      this.runs.sort((a, b) => b.ts - a.ts);
      
      this.options.logger?.info?.(`加载了 ${this.runs.length} 条定时任务运行记录`);
    } catch (err) {
      this.options.logger?.warn?.(`加载定时任务运行记录失败: ${err.message}`);
    }
  }

  listRuns(options = {}) {
    const { days = 7, agent = null } = options;
    
    const now = Date.now();
    const startTime = now - days * 24 * 60 * 60 * 1000;
    
    const results = [];
    
    for (const run of this.runs) {
      // 时间过滤
      if (run.ts < startTime) continue;
      
      // agent 过滤
      if (agent && run.sessionKey) {
        const match = run.sessionKey.match(/^agent:([^:]+):/);
        if (!match || match[1] !== agent) continue;
      }
      
      // 获取任务名称
      const job = this.jobs.get(run.jobId);
      const jobName = job?.name || run.jobId;
      
      // 格式化时间
      const date = new Date(run.ts);
      const timeStr = date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
      
      // 提取 agent 名称
      let agentName = 'unknown';
      if (run.sessionKey) {
        const match = run.sessionKey.match(/^agent:([^:]+):/);
        if (match) agentName = match[1];
      }
      
      results.push({
        time: timeStr,
        timestamp: run.ts,
        jobId: run.jobId,
        jobName,
        agent: agentName,
        status: run.status,
        summary: run.summary ? run.summary.substring(0, 200) : null,
        duration: run.durationMs ? Math.round(run.durationMs / 1000) : null,
        sessionId: run.sessionId,
        sessionKey: run.sessionKey
      });
    }
    
    return results;
  }
}
