#!/usr/bin/env node
/* static-check.js — CI 静态检查（无第三方依赖，确定性通过）
 * 1. index.html / agent/index.html 的内联 <script> 全部通过语法解析
 * 2. i18n 覆盖：所有真实 T('...') / T("...") 调用字面量都是 I18N_EN 的键，
 *    且无空译文（剥离注释、跳过浏览器打包产物块，排除假匹配）
 * 3. 结构 sanity：关键 DOM id / 引擎函数存在
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
let failed = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' | ' + detail : ''));
  if (!ok) failed++;
}

/* ---- 提取 <script> 块（只有 </script 能闭合，与浏览器规则一致） ---- */
function scriptBlocks(html) {
  const blocks = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script/gi;
  let m;
  while ((m = re.exec(html)) !== null) blocks.push(m[1]);
  return blocks;
}

/* ---- 剥离 JS 注释（尊重字符串与转义） ---- */
function stripComments(src) {
  let out = '', inStr = false, q = '', i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += n || ''; i += 2; continue; }
      if (c === q) inStr = false;
      i++; continue;
    }
    if (c === '"' || c === "'") { inStr = true; q = c; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  return out;
}

/* ---- 花括号配平提取对象字面量（尊重字符串与转义） ---- */
function extractObject(src, header) {
  const start = src.indexOf(header);
  if (start === -1) return null;
  const open = src.indexOf('{', start + header.length - 1);
  if (open === -1) return null;
  let depth = 0, inStr = false, q = '';
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === q) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; q = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return null;
}

/* ---- 1+3：主站（C++ 运行器） ---- */
function findRunner() {
  for (const name of ['index.html', 'C++运行器.html']) {
    const p = path.join(root, name);
    if (fs.existsSync(p)) return { name, text: fs.readFileSync(p, 'utf8') };
  }
  return null;
}
const runnerFile = findRunner();
check('主站文件存在（index.html / C++运行器.html）', runnerFile !== null, runnerFile && runnerFile.name);
const runner = runnerFile.text;

const runnerBlocks = scriptBlocks(runner);
check('主站 script 块数量 >= 1', runnerBlocks.length >= 1, runnerBlocks.length + ' 块');
runnerBlocks.forEach((b, i) => {
  try { new Function(b); check('主站 script#' + i + ' 语法', true); }
  catch (e) { check('主站 script#' + i + ' 语法', false, e.message); }
});

const dictText = extractObject(runner, 'var I18N_EN = {');
check('I18N_EN 词典对象可定位', dictText !== null);
let dict = {};
try { dict = eval('(' + dictText + ')'); } catch (e) { check('I18N_EN 可解析', false, e.message); }
const dictKeys = Object.keys(dict);
check('I18N_EN 键数量 >= 400', dictKeys.length >= 400, dictKeys.length + ' 键');
const emptyVals = dictKeys.filter(k => !dict[k] || !String(dict[k]).trim());
check('I18N_EN 无空译文', emptyVals.length === 0, emptyVals.slice(0, 3).join(' / '));

/* T() 调用全覆盖：剥注释 + 跳过浏览器打包产物（browserify bundle，其内部 require 也叫 T）
 * 注意空间桥接：词典键经 eval 后是运行时值（\n = 真换行），
 * 调用字面量也必须 eval 回运行时值再比对，否则带转义的键全假阳性 */
const tCalls = [];
const tRe = /\bT\(\s*((['"])(?:\\.|(?!\2)[\s\S])*?\2)\s*\)/g;
runnerBlocks.forEach((b) => {
  if (b.indexOf('base64-js') !== -1) return; // vendored bundle，非本项目代码
  const code = stripComments(b);
  let tm;
  while ((tm = tRe.exec(code)) !== null) {
    try { tCalls.push(eval('(' + tm[1] + ')')); } catch (e) { tCalls.push(tm[1]); }
  }
});
check('T() 调用数 >= 400', tCalls.length >= 400, tCalls.length + ' 处');
const missing = [...new Set(tCalls.filter(k => !(k in dict)))];
check('T() 调用全部命中词典', missing.length === 0, missing.slice(0, 3).join(' / '));

/* 引擎与按钮 */
check('i18n 引擎函数在位', /function T\(/.test(runner) && /function applyLang/.test(runner) && /function toggleLang/.test(runner));
check('语言切换按钮在位', /id="langBtn"/.test(runner));

/* ---- 1+3：小 A agent ---- */
const agent = fs.readFileSync(path.join(root, 'agent', 'index.html'), 'utf8');
const agentBlocks = scriptBlocks(agent);
check('agent script 块数量 >= 1', agentBlocks.length >= 1, agentBlocks.length + ' 块');
agentBlocks.forEach((b, i) => {
  try { new Function(b); check('agent script#' + i + ' 语法', true); }
  catch (e) { check('agent script#' + i + ' 语法', false, e.message); }
});
['input', 'send', 'chat', 'memBtn', 'setBtn'].forEach(id =>
  check('agent 关键元素 #' + id, agent.indexOf('id="' + id + '"') !== -1));
check('agent 三级降级链路在位', /function aiChat\(/.test(agent) && /function aiChatFallback/.test(agent) && /function msChat/.test(agent));
check('agent 工具声明在位', /get_weather/.test(agent) && /wiki_lookup/.test(agent) && /remember_fact/.test(agent));
check('agent fetch 超时封装在位', /AbortController/.test(agent));

/* ---- 仓库级文件 ---- */
['README.md', 'LICENSE'].forEach(f =>
  check('仓库文件存在: ' + f, fs.existsSync(path.join(root, f))));

console.log('\n' + (failed === 0 ? '静态检查全部通过' : failed + ' 项失败'));
process.exit(failed === 0 ? 0 : 1);
