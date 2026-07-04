#!/usr/bin/env node
// mock MCP server —— mcp-scan 测试专用。
//
// 协议语义:
//   stdin  : newline-delimited JSON-RPC 2.0 请求
//   stdout : newline-delimited JSON-RPC 2.0 响应
//   stderr : 诊断(测试不消费)
//
// 配置(全部经环境变量,不接 argv — 测试场景下 process.env 注入更稳):
//   MOCK_TOOLS_FILE   : 必填,tools/list 应返回的工具列表 JSON 文件路径
//   MOCK_LOG_FILE     : 可选,每收到一个 method 都追加一行到该文件;测试断言全程无 tools/call
//   MOCK_PROTOCOL     : 可选,initialize 响应的 protocolVersion,默认 "2025-06-18"
//   MOCK_SERVER_NAME  : 可选,serverInfo.name,默认 "mock-mcp"
//   MOCK_HANG         : 可选,任意非空值 → 永远不响应(用于超时测试)
//
// 设计要点:
//   - 每次 tools/list 调用都重新读 MOCK_TOOLS_FILE:测试可在两次扫描之间改文件模拟 rug-pull。
//   - 通知(notifications/* / 没有 id)绝不写响应(JSON-RPC 2.0 规则)。
//   - 未知 method → 写回 JSON-RPC error -32601。
//   - 解析失败 → 写回 JSON-RPC error -32700。
//   - 退出:EOF 时自然退出。

import { readFileSync } from 'node:fs';
import { appendFileSync } from 'node:fs';

const toolsFile = process.env.MOCK_TOOLS_FILE;
const logFile = process.env.MOCK_LOG_FILE;
const protocol = process.env.MOCK_PROTOCOL || '2025-06-18';
const serverName = process.env.MOCK_SERVER_NAME || 'mock-mcp';
const hang = process.env.MOCK_HANG;

if (!toolsFile) {
  process.stderr.write('mock-server: MOCK_TOOLS_FILE 未设置\n');
  process.exit(2);
}

function logMethod(method) {
  if (!logFile) return;
  try {
    appendFileSync(logFile, `${method}\n`, 'utf8');
  } catch {
    // 日志写不进不应阻塞协议
  }
}

function readTools() {
  try {
    const raw = readFileSync(toolsFile, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    // 静默吞掉会让测试误判难排查:失败写 stderr(不影响协议 stdout)
    process.stderr.write(`mock-server: 读取工具文件失败: ${e?.message ?? e}\n`);
    return [];
  }
}

function writeResponse(res) {
  process.stdout.write(`${JSON.stringify(res)}\n`);
}

function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function err(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

let buffer = '';
process.stdin.setEncoding('utf8');

process.stdin.on('data', (chunk) => {
  if (hang) return; // 永远不响应
  buffer += chunk;
  for (;;) {
    const idx = buffer.indexOf('\n');
    if (idx === -1) break;
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;

    let req;
    try {
      req = JSON.parse(line);
    } catch {
      writeResponse(err(null, -32700, 'JSON 解析失败'));
      continue;
    }

    if (!req || typeof req !== 'object') {
      writeResponse(err(null, -32600, '请求必须是 JSON 对象'));
      continue;
    }

    const { method, id } = req;
    logMethod(typeof method === 'string' ? method : '<no-method>');

    if (typeof method !== 'string') {
      if (id !== undefined) writeResponse(err(id, -32600, 'method 字段缺失'));
      continue;
    }

    // 通知:无 id,不响应
    if (id === undefined) continue;

    switch (method) {
      case 'initialize':
        writeResponse(ok(id, {
          protocolVersion: protocol,
          capabilities: { tools: {} },
          serverInfo: { name: serverName, version: '0.0.0-mock' },
        }));
        break;
      case 'tools/list':
        writeResponse(ok(id, { tools: readTools() }));
        break;
      case 'ping':
        writeResponse(ok(id, {}));
        break;
      default:
        writeResponse(err(id, -32601, `不支持的方法: ${method}`));
    }
  }
});

process.stdin.on('end', () => {
  // EOF 时自然退出
  process.exit(0);
});