/*
 * 装窑预检 Web 应用 —— Express 后端
 * 提供静态页面与方案 JSON 的读写持久化（data/plan.json）。
 */
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PLAN_FILE = path.join(DATA_DIR, 'plan.json');

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* 内置示例方案：首次启动自动初始化 */
function defaultPlan() {
  return {
    name: '示例装窑方案',
    tempStart: 20,
    tempTarget: 1250,
    kiln: { width: 80, depth: 60 },
    bodies: [
      { id: 'b1', name: '碗坯 A', w: 16, h: 16, cx: 22, cy: 20, angle: 0, alpha: 8 },
      { id: 'b2', name: '碗坯 B', w: 16, h: 16, cx: 38.1, cy: 20, angle: 0, alpha: 8 },
      { id: 'b3', name: '斜置方盘', w: 20, h: 12, cx: 62, cy: 44, angle: 35, alpha: 6 },
    ],
  };
}

function ensurePlanFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PLAN_FILE)) {
    fs.writeFileSync(PLAN_FILE, JSON.stringify(defaultPlan(), null, 2), 'utf8');
    console.log('[init] 未找到方案文件，已写入示例方案:', PLAN_FILE);
  }
}

function readPlan() {
  ensurePlanFile();
  return JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'));
}

function writePlan(plan) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = PLAN_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(plan, null, 2), 'utf8');
  fs.renameSync(tmp, PLAN_FILE);
}

function validatePlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'object') return ['请求体必须是 JSON 对象'];
  if (typeof plan.tempStart !== 'number' || !Number.isFinite(plan.tempStart)) errors.push('起始温度必须是数字');
  if (typeof plan.tempTarget !== 'number' || !Number.isFinite(plan.tempTarget)) errors.push('目标温度必须是数字');
  if (!plan.kiln || plan.kiln.width <= 0 || plan.kiln.depth <= 0) errors.push('窑室宽/深必须为正数');
  if (!Array.isArray(plan.bodies)) errors.push('bodies 必须是数组');
  if (Array.isArray(plan.bodies)) {
    for (const b of plan.bodies) {
      if (!(b.w > 0) || !(b.h > 0)) errors.push(`坯体「${b.name || b.id}」宽/高非法`);
      if (typeof b.alpha !== 'number' || b.alpha < 0) errors.push(`坯体「${b.name || b.id}」线膨胀系数非法`);
    }
  }
  return errors;
}

app.get('/api/plan', (req, res) => {
  try {
    res.json(readPlan());
  } catch (err) {
    res.status(500).json({ error: '读取方案失败: ' + err.message });
  }
});

app.put('/api/plan', (req, res) => {
  const errors = validatePlan(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join('；') });
  try {
    writePlan(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: '保存方案失败: ' + err.message });
  }
});

app.post('/api/plan/reset', (req, res) => {
  try {
    const plan = defaultPlan();
    writePlan(plan);
    res.json(plan);
  } catch (err) {
    res.status(500).json({ error: '重置失败: ' + err.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

ensurePlanFile();
const server = app.listen(PORT, () => {
  console.log(`陶艺装窑预检应用已启动: http://localhost:${PORT}`);
});

module.exports = { app, server };
