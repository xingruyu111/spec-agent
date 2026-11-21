/** 项目知识索引：本地文件缓存 + 任务相关检索，无外部向量服务。 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const TEXT_EXT = new Set([
  '.md', '.txt', '.yaml', '.yml', '.json', '.ts', '.tsx', '.js', '.jsx',
  '.py', '.rs', '.go', '.java', '.cs', '.cpp', '.c', '.h', '.css', '.html',
  '.sql', '.toml', '.ini', '.sh', '.ps1',
]);
const SKIP = new Set([
  '.git', '.spec-agent', 'node_modules', 'worktrees', 'dist', 'build', 'coverage',
  '.next', '.turbo', '.cache', '.claude',
]);

type IndexedFile = {
  mtimeMs: number;
  size: number;
  chunks: string[];
};

export class ProjectKnowledgeIndex {
  private readonly files = new Map<string, IndexedFile>();

  constructor(private readonly root: string) {}

  /** 返回 path + 片段；调用方负责把摘要放进 prompt。 */
  search(task: string, limit = 6): string[] {
    this.refresh(this.root);
    const terms = tokenize(task);
    const scored: Array<{ score: number; path: string; chunk: string }> = [];
    for (const [path, file] of this.files) {
      const pathScore = scoreText(path, terms) * 2;
      file.chunks.forEach((chunk, index) => {
        const score = pathScore + scoreText(chunk, terms);
        if (score > 0) {
          scored.push({ score, path, chunk: `${path}#${index + 1}\n${chunk}` });
        }
      });
    }
    return scored
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, Math.max(0, limit))
      .map((entry) => entry.chunk);
  }

  private refresh(dir: string): void {
    if (this.files.size >= 2000) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        this.refresh(path);
        continue;
      }
      if (!entry.isFile() || !TEXT_EXT.has(extname(entry.name).toLowerCase())) continue;
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.size > 512 * 1024) continue;
      const key = relative(this.root, path).replace(/\\/g, '/');
      const cached = this.files.get(key);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) continue;
      let content: string;
      try {
        content = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      this.files.set(key, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        chunks: chunkDocument(content),
      });
      if (this.files.size >= 2000) return;
    }
  }
}

export function createKnowledgeIndex(root: string): ProjectKnowledgeIndex {
  return new ProjectKnowledgeIndex(root);
}

function chunkDocument(content: string): string[] {
  const paragraphs = content.split(/\n\s*\n/);
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length > 1600 && current) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = next;
    }
    while (current.length > 2400) {
      chunks.push(current.slice(0, 2400));
      current = current.slice(2400);
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks.slice(0, 100);
}

function tokenize(value: string): string[] {
  const lower = value.toLowerCase();
  const words = lower.match(/[a-z0-9_./-]{2,}|[\u3400-\u9fff]/g) ?? [];
  const cjk = lower.replace(/[^\u3400-\u9fff]/g, '');
  const grams: string[] = [];
  for (let index = 0; index < cjk.length - 1; index += 1) {
    grams.push(cjk.slice(index, index + 2));
  }
  return Array.from(new Set([...words, ...grams]));
}

function scoreText(text: string, terms: string[]): number {
  const lower = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (lower.includes(term)) score += term.length >= 3 ? 2 : 1;
  }
  return score;
}
