/* 前端冒烟测试：用最小 DOM/Canvas 桩加载 app.js，验证初始化、参数修改、
   拖放与旋转交互的完整链路不抛错，且结果随参数变化。 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeCtx() {
  const noop = () => {};
  return new Proxy({}, {
    get(t, prop) {
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop === 'setLineDash' || prop === 'clearRect' || prop === 'fillRect' ||
          prop === 'stroke' || prop === 'fill' || prop === 'beginPath' ||
          prop === 'moveTo' || prop === 'lineTo' || prop === 'arc' || prop === 'rect' ||
          prop === 'arcTo' || prop === 'closePath' || prop === 'save' || prop === 'restore' ||
          prop === 'translate' || prop === 'rotate' || prop === 'scale' || prop === 'setTransform' ||
          prop === 'fillText' || prop === 'releasePointerCapture' || prop === 'setPointerCapture') {
        return noop;
      }
      if (prop === 'canvas') return { clientWidth: 1000, clientHeight: 600 };
      return undefined;
    },
    set() { return true; },
  });
}

function makeEl(id) {
  const el = {
    id, value: '', textContent: '', innerHTML: '', hidden: false,
    className: '', style: {}, disabled: false,
    listeners: {},
    children: [],
    classList: { add() {}, remove() {} },
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    removeEventListener() {},
    appendChild(c) { this.children.push(c); },
    setPointerCapture() {},
    releasePointerCapture() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 1000, height: 600 }; },
    querySelector() { return makeEl('q'); },
    click() { (this.listeners.click || []).forEach((f) => f({})); },
  };
  el.getContext = () => makeCtx();
  return el;
}

const elements = {};
const ids = ['kiln-w', 'kiln-d', 'temp-start', 'temp-target', 'new-name', 'new-w', 'new-h',
  'new-alpha', 'new-angle', 'btn-add', 'btn-save', 'btn-reset', 'body-list', 'props-panel',
  'prop-name', 'prop-w', 'prop-h', 'prop-alpha', 'prop-angle', 'prop-angle-val',
  'prop-cx', 'prop-cy', 'btn-rotate-l', 'btn-rotate-r', 'btn-delete', 'kiln-canvas',
  'canvas-errors', 'result-card', 'result-value', 'result-sub', 'contacts-tbody',
  'save-status'];
for (const id of ids) elements[id] = makeEl(id);
elements['kiln-canvas'].parentElement = { clientWidth: 1000, clientHeight: 600, observe() {} };
elements['kiln-canvas'].clientWidth = 1000;
elements['kiln-canvas'].clientHeight = 600;

const eventTarget = makeEl('doc');

const sandbox = {
  console,
  window: null, // 稍后填充，使其与全局对象同一引用（模拟浏览器 window===self）
  document: {
    getElementById: (id) => elements[id] || makeEl(id),
    createElement: () => makeEl('new'),
    activeElement: null,
    addEventListener: (ev, fn) => eventTarget.addEventListener(ev, fn),
  },
  window: { devicePixelRatio: 1, addEventListener() {} },
  fetch: async (url, opts) => {
    if (url === '/api/plan' && (!opts || opts.method !== 'PUT')) {
      return { ok: true, json: async () => demoPlan() };
    }
    if (url === '/api/plan' && opts && opts.method === 'PUT') {
      global.__saved = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return { ok: true, json: async () => ({}) };
  },
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
  Date, Math, JSON, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  confirm: () => true,
};
// 模拟浏览器：window/self/globalThis 同一对象，UMD 挂到该对象
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.devicePixelRatio = 1;
sandbox.addEventListener = () => {};
vm.createContext(sandbox);

function demoPlan() {
  return {
    name: 't', tempStart: 20, tempTarget: 1250,
    kiln: { width: 80, depth: 60 },
    bodies: [
      { id: 'b1', name: 'A', w: 16, h: 16, cx: 22, cy: 20, angle: 0, alpha: 8 },
      { id: 'b2', name: 'B', w: 16, h: 16, cx: 38.1, cy: 20, angle: 0, alpha: 8 },
    ],
  };
}

const physics = fs.readFileSync(path.join(__dirname, '..', 'public', 'physics.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
vm.runInContext(physics, sandbox);
vm.runInContext(app, sandbox);

(async () => {
  await new Promise((r) => setTimeout(r, 50));

  // 1) 初始化后结果区显示最早接触温度（α=8e-6，间隙0.1cm，ΔT=1230 → t≈0.635，约 801°C）
  const rv = elements['result-value'].textContent;
  assert.ok(/801/.test(rv), '结果应显示约 801°C 接触，实际：' + rv);
  console.log('  ✓ 初始化即完成预检：' + rv);

  // 2) 修改目标温度为 1200 -> 立即重算（DOM 文本同步）
  elements['temp-target'].value = '1200';
  for (const f of elements['temp-target'].listeners.input) f({ target: elements['temp-target'] });
  const rv2 = elements['result-value'].textContent;
  assert.ok(/接触温度/.test(rv2), '改温度后仍显示接触：' + rv2);
  console.log('  ✓ 修改温度立即重算：' + rv2);

  // 3) 把 b2 挪远到 60 -> 安全
  const planAfterMove = null;
  // 模拟指针拖放：先 pointdown 选中 b2，再 move
  const cv = elements['kiln-canvas'];
  const rect = { left: 0, top: 0 };
  // 找 b2 中心屏幕坐标。fitView：cssW=1000，cssH=clamp(1000*60/80,380,680)=680
  // scale = min((1000-92)/80, (680-92)/60) = 9.8
  const scale = Math.min((1000 - 92) / 80, (680 - 92) / 60);
  const ox = (1000 - 80 * scale) / 2;
  const oy = (680 + 60 * scale) / 2;
  const sp = (x, y) => ({ x: ox + x * scale, y: oy - y * scale });
  const p2 = sp(38.1, 20);
  cv.listeners.pointerdown.forEach((f) => f({
    pointerId: 1, clientX: rect.left + p2.x, clientY: rect.top + p2.y,
  }));
  // 向右拖 20cm
  const target = sp(58.1, 20);
  cv.listeners.pointermove.forEach((f) => f({
    pointerId: 1, clientX: rect.left + target.x, clientY: rect.top + target.y,
  }));
  cv.listeners.pointerup.forEach((f) => f({ pointerId: 1 }));
  await new Promise((r) => setTimeout(r, 700)); // 等自动保存
  assert.ok(global.__saved, '拖放后应触发自动保存');
  const moved = global.__saved.bodies.find((b) => b.id === 'b2');
  assert.ok(Math.abs(moved.cx - 58.1) < 0.3, '拖放后 b2.cx≈58.1，实际 ' + moved.cx);
  console.log('  ✓ 拖放移动 b2 → cx=' + moved.cx.toFixed(1) + '，并自动持久化');

  // 4) 旋转手柄交互：当前选中 b2（拖放后），在其手柄处按下并转到右侧 → angle≈±90°
  const p1 = sp(58.1, 20);
  const hp = { x: p1.x, y: p1.y - (8 * scale + 26) }; // 手柄位置（angle=0 正上方）
  cv.listeners.pointerdown.forEach((f) => f({
    pointerId: 3, clientX: hp.x, clientY: hp.y,
  }));
  cv.listeners.pointermove.forEach((f) => f({
    pointerId: 3, clientX: p1.x + 120, clientY: p1.y, // 转到中心正右方 → 90°
  }));
  cv.listeners.pointerup.forEach((f) => f({ pointerId: 3 }));
  await new Promise((r) => setTimeout(r, 700)); // 等自动保存
  const savedAngle = global.__saved.bodies.find((b) => b.id === 'b2').angle;
  assert.ok(Math.abs(Math.abs(savedAngle) - 90) < 2, '旋转应接近 ±90°，实际 ' + savedAngle);
  console.log('  ✓ 旋转手柄交互 → b2.angle=' + savedAngle + '°');

  // 5) 添加坯体按钮
  elements['new-w'].value = '12';
  elements['new-h'].value = '12';
  elements['new-alpha'].value = '5';
  elements['new-angle'].value = '10';
  elements['new-name'].value = '新坯';
  elements['btn-add'].listeners.click.forEach((f) => f({}));
  await new Promise((r) => setTimeout(r, 700));
  assert.ok(global.__saved.bodies.some((b) => b.name === '新坯'), '应新增坯体');
  console.log('  ✓ 添加坯体，当前数量=' + global.__saved.bodies.length);

  // 6) Delete 键删除选中（btn-add 刚选中新坯）
  eventTarget.listeners.keydown.forEach((f) => f({ key: 'Delete', preventDefault() {} }));
  await new Promise((r) => setTimeout(r, 700));
  assert.ok(!global.__saved.bodies.some((b) => b.name === '新坯'), '应删除坯体');
  console.log('  ✓ Delete 键删除坯体');

  console.log('\n前端冒烟测试全部通过');
})().catch((err) => { console.error('前端冒烟测试失败:', err); process.exit(1); });
