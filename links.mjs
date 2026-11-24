import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWrite } from './core.mjs';

export const LINK_GROUPS = Object.freeze([
  { id: 'ai', name: 'AI 网页', icon: 'sparkles' },
  { id: 'community', name: '社区', icon: 'messages-square' },
  { id: 'docs', name: '文档学习', icon: 'book-open' },
  { id: 'development', name: '开发工具', icon: 'code-2' },
  { id: 'tools', name: '日常工具', icon: 'shapes' },
  { id: 'research', name: '科研检索', icon: 'graduation-cap' },
  { id: 'status', name: '服务状态', icon: 'activity' },
]);
export const DEFAULT_LINKS = Object.freeze([
  { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/', group: 'ai', note: 'GPT 网页版' },
  { id: 'gemini', name: 'Gemini', url: 'https://gemini.google.com/', group: 'ai', note: 'Google AI 助手' },
  { id: 'claude', name: 'Claude', url: 'https://claude.ai/', group: 'ai', note: '写作与编程' },
  { id: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/', group: 'ai', note: '深度求索' },
  { id: 'aistudio', name: 'AI Studio', url: 'https://aistudio.google.com/', group: 'ai', note: 'Google 模型体验' },
  { id: 'notebooklm', name: 'NotebookLM', url: 'https://notebooklm.google.com/', group: 'ai', note: '资料整理与阅读' },
  { id: 'perplexity', name: 'Perplexity', url: 'https://www.perplexity.ai/', group: 'ai', note: 'AI 搜索与资料来源' },
  { id: 'kimi', name: 'Kimi', url: 'https://www.kimi.com/', group: 'ai', note: '长文阅读与问答' },
  { id: 'doubao', name: '豆包', url: 'https://www.doubao.com/', group: 'ai', note: '中文 AI 助手' },
  { id: 'qwen', name: 'Qwen', url: 'https://chat.qwen.ai/', group: 'ai', note: '通义模型体验' },
  { id: 'grok', name: 'Grok', url: 'https://grok.com/', group: 'ai', note: 'xAI 助手' },
  { id: 'poe', name: 'Poe', url: 'https://poe.com/', group: 'ai', note: '多模型对话' },
  { id: 'linuxdo', name: 'LINUX DO', url: 'https://linux.do/', group: 'community', note: '技术交流论坛' },
  { id: 'github', name: 'GitHub', url: 'https://github.com/', group: 'community', note: '开源项目与代码' },
  { id: 'huggingface', name: 'Hugging Face', url: 'https://huggingface.co/', group: 'community', note: '模型与数据集' },
  { id: 'v2ex', name: 'V2EX', url: 'https://www.v2ex.com/', group: 'community', note: '开发者社区' },
  { id: 'stackoverflow', name: 'Stack Overflow', url: 'https://stackoverflow.com/', group: 'community', note: '编程问答' },
  { id: 'kaggle', name: 'Kaggle', url: 'https://www.kaggle.com/', group: 'community', note: '数据科学与竞赛' },
  { id: 'devto', name: 'DEV Community', url: 'https://dev.to/', group: 'community', note: '开发实践与分享' },
  { id: 'reddit', name: 'Reddit', url: 'https://www.reddit.com/', group: 'community', note: '兴趣与技术讨论' },
  { id: 'mdn', name: 'MDN', url: 'https://developer.mozilla.org/zh-CN/', group: 'docs', note: 'Web 开发文档' },
  { id: 'openai-docs', name: 'OpenAI 文档', url: 'https://developers.openai.com/', group: 'docs', note: 'API 与开发指南' },
  { id: 'claude-docs', name: 'Claude 文档', url: 'https://platform.claude.com/docs/overview', group: 'docs', note: 'Claude API 与工具' },
  { id: 'gemini-docs', name: 'Gemini 文档', url: 'https://ai.google.dev/gemini-api/docs', group: 'docs', note: 'Gemini API 指南' },
  { id: 'microsoft-learn', name: 'Microsoft Learn', url: 'https://learn.microsoft.com/zh-cn/', group: 'docs', note: '微软产品与开发文档' },
  { id: 'python-docs', name: 'Python 文档', url: 'https://docs.python.org/zh-cn/3/', group: 'docs', note: '语言与标准库' },
  { id: 'freecodecamp', name: 'freeCodeCamp', url: 'https://www.freecodecamp.org/chinese/', group: 'docs', note: '免费编程课程' },
  { id: 'devdocs', name: 'DevDocs', url: 'https://devdocs.io/', group: 'docs', note: '多语言文档检索' },
  { id: 'regex101', name: 'regex101', url: 'https://regex101.com/', group: 'development', note: '正则表达式调试' },
  { id: 'jsoncrack', name: 'JSON Crack', url: 'https://jsoncrack.com/', group: 'development', note: 'JSON 可视化' },
  { id: 'cyberchef', name: 'CyberChef', url: 'https://gchq.github.io/CyberChef/', group: 'development', note: '编码转换与数据处理' },
  { id: 'codepen', name: 'CodePen', url: 'https://codepen.io/', group: 'development', note: '前端代码实验' },
  { id: 'caniuse', name: 'Can I use', url: 'https://caniuse.com/', group: 'development', note: '浏览器特性兼容性' },
  { id: 'crontab', name: 'crontab.guru', url: 'https://crontab.guru/', group: 'development', note: '定时任务表达式' },
  { id: 'gitignore', name: 'gitignore.io', url: 'https://www.toptal.com/developers/gitignore/', group: 'development', note: '生成 Git 忽略规则' },
  { id: 'deepl', name: 'DeepL', url: 'https://www.deepl.com/translator', group: 'tools', note: '翻译' },
  { id: 'excalidraw', name: 'Excalidraw', url: 'https://excalidraw.com/', group: 'tools', note: '白板与流程图' },
  { id: 'ilovepdf', name: 'iLovePDF', url: 'https://www.ilovepdf.com/zh-cn', group: 'tools', note: 'PDF 合并与转换' },
  { id: 'photopea', name: 'Photopea', url: 'https://www.photopea.com/', group: 'tools', note: '在线图片编辑' },
  { id: 'squoosh', name: 'Squoosh', url: 'https://squoosh.app/', group: 'tools', note: '图片压缩与格式转换' },
  { id: 'diagrams', name: 'draw.io', url: 'https://app.diagrams.net/', group: 'tools', note: '架构图与流程图' },
  { id: 'tinypng', name: 'TinyPNG', url: 'https://tinypng.com/', group: 'tools', note: '图片压缩' },
  { id: 'typst', name: 'Typst', url: 'https://typst.app/', group: 'tools', note: '文档与公式排版' },
  { id: 'scholar', name: 'Google Scholar', url: 'https://scholar.google.com/', group: 'research', note: '学术文献检索' },
  { id: 'semantic-scholar', name: 'Semantic Scholar', url: 'https://www.semanticscholar.org/', group: 'research', note: '论文与引用网络' },
  { id: 'arxiv', name: 'arXiv', url: 'https://arxiv.org/', group: 'research', note: '预印本论文' },
  { id: 'consensus', name: 'Consensus', url: 'https://consensus.app/', group: 'research', note: '基于论文的 AI 检索' },
  { id: 'pubmed', name: 'PubMed', url: 'https://pubmed.ncbi.nlm.nih.gov/', group: 'research', note: '医学与生命科学文献' },
  { id: 'zotero', name: 'Zotero', url: 'https://www.zotero.org/', group: 'research', note: '参考文献管理' },
  { id: 'connected-papers', name: 'Connected Papers', url: 'https://www.connectedpapers.com/', group: 'research', note: '相关论文图谱' },
  { id: 'openai-status', name: 'OpenAI 状态', url: 'https://status.openai.com/', group: 'status', note: 'ChatGPT 与 API 状态' },
  { id: 'claude-status', name: 'Claude 状态', url: 'https://status.claude.com/', group: 'status', note: 'Claude 与 API 状态' },
  { id: 'google-status', name: 'Google Cloud 状态', url: 'https://status.cloud.google.com/', group: 'status', note: 'Google 云服务状态' },
  { id: 'github-status', name: 'GitHub 状态', url: 'https://www.githubstatus.com/', group: 'status', note: 'GitHub 服务状态' },
  { id: 'hf-status', name: 'Hugging Face 状态', url: 'https://status.huggingface.co/', group: 'status', note: '模型平台服务状态' },
].map(link => Object.freeze({ ...link, pinned: ['chatgpt', 'gemini', 'claude', 'linuxdo', 'github', 'notebooklm'].includes(link.id) })));

export function linkUrl(value) {
  if (typeof value !== 'string' || value.length > 2000 || /[\s\\\u0000-\u001f\u007f]/.test(value) || !value.startsWith('https://'))
    throw new Error('请输入完整的 HTTPS 网页地址。');
  let url;
  try { url = new URL(value); } catch { throw new Error('网页地址无效。'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password)
    throw new Error('网页地址不能包含账号或密码。');
  return url.href;
}
function clean(input) {
  if (!input || typeof input.id !== 'string' || !/^[a-z0-9-]{1,80}$/.test(input.id)) throw new Error('链接编号无效。');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 40 || /[\u0000-\u001f\u007f]/.test(input.name))
    throw new Error('名称需为 1–40 个字符。');
  if (!LINK_GROUPS.some(group => group.id === input.group)) throw new Error('请选择链接分类。');
  const note = input.note ?? '';
  if (typeof note !== 'string' || note.length > 60 || /[\u0000-\u001f\u007f]/.test(note)) throw new Error('链接说明过长。');
  if (input.pinned !== undefined && typeof input.pinned !== 'boolean') throw new Error('首页固定选项无效。');
  return { id: input.id, name: input.name.trim(), url: linkUrl(input.url), group: input.group, note: note.trim(), pinned: input.pinned === true };
}

export class LinkStore {
  constructor(dataDir) { this.file = path.join(dataDir, 'links.json'); this.tail = Promise.resolve(); }
  async list() {
    let bytes;
    try { bytes = await fs.readFile(this.file); }
    catch (e) { if (e.code === 'ENOENT') return structuredClone(DEFAULT_LINKS); throw new Error('无法读取常用链接，请检查数据目录。'); }
    try {
      if (bytes.length > 512 * 1024) throw new Error();
      const saved = JSON.parse(bytes);
      if (saved.version !== 1 || !Array.isArray(saved.links) || saved.links.length > 128) throw new Error();
      const links = saved.links.map(clean);
      if (new Set(links.map(link => link.id)).size !== links.length || links.filter(link => link.pinned).length > 8) throw new Error();
      return links;
    } catch { throw new Error('常用链接文件格式有误，原文件已保留。'); }
  }
  exclusive(action) {
    const next = this.tail.then(action); this.tail = next.catch(() => {}); return next;
  }
  save(input) {
    return this.exclusive(async () => {
      const links = await this.list(), value = clean({ ...input, id: input.id || crypto.randomUUID() });
      const index = links.findIndex(link => link.id === value.id);
      if (index < 0) { if (links.length >= 128) throw new Error('最多保存 128 个链接。'); links.push(value); }
      else links[index] = value;
      if (links.filter(link => link.pinned).length > 8) throw new Error('首页最多固定 8 个链接，请先取消一个。');
      await atomicWrite(this.file, JSON.stringify({ version: 1, links }, null, 2));
      return links;
    });
  }
  remove(id) {
    return this.exclusive(async () => {
      const links = await this.list();
      if (!links.some(link => link.id === id)) throw new Error('链接已移除，请刷新后重试。');
      const next = links.filter(link => link.id !== id);
      await atomicWrite(this.file, JSON.stringify({ version: 1, links: next }, null, 2));
      return next;
    });
  }
  setPinned(id, pinned) {
    return this.exclusive(async () => {
      if (typeof pinned !== 'boolean') throw new Error('首页固定选项无效。');
      const links = await this.list(), link = links.find(link => link.id === id);
      if (!link) throw new Error('链接已移除，请刷新后重试。');
      link.pinned = pinned;
      if (links.filter(link => link.pinned).length > 8) throw new Error('首页最多固定 8 个链接，请先取消一个。');
      await atomicWrite(this.file, JSON.stringify({ version: 1, links }, null, 2));
      return links;
    });
  }
  async resolve(id) {
    const link = (await this.list()).find(link => link.id === id);
    if (!link) throw new Error('链接已移除，请刷新后重试。');
    return linkUrl(link.url);
  }
}
