/* 物理/碰撞核心的简单断言测试：npm test */
'use strict';

const assert = require('assert');
const { analyze, contactBodyBody } = require('../public/physics.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  ✓ ' + name);
    passed++;
  } catch (err) {
    console.error('  ✗ ' + name);
    console.error('    ' + err.message);
    process.exitCode = 1;
  }
}

const DT = 1200; // 目标-起始温差
const basePlan = (bodies, extra) => ({
  tempStart: 20,
  tempTarget: 20 + DT,
  kiln: { width: 100, depth: 100 },
  ...extra,
  bodies,
});

const mk = (id, over) => ({
  id, name: id, w: 10, h: 10, cx: 50, cy: 50, angle: 0, alpha: 10, ...over,
});

test('轴对齐坯体：间隙在线性膨胀下闭合，最早接触温度解析正确', () => {
  // 两个 10×10、α=10e-6（界面值 10）的方块，中心距 10.05（初始间隙 0.05cm）
  // 每侧全行程膨胀 5*10e-6*1200 = 0.06cm，合计速率 0.12cm/t
  // t* = 0.05 / 0.12 = 5/12
  const r = analyze(basePlan([mk('a', { cx: 44.975, cy: 50 }), mk('b', { cx: 55.025, cy: 50 })]));
  assert.strictEqual(r.ok, true);
  assert.ok(r.earliestContact, '应存在最早接触');
  assert.strictEqual(r.earliestContact.kind, 'body');
  assert.ok(Math.abs(r.earliestContact.t - 5 / 12) < 1e-9, 't* 应为 5/12, 实际 ' + r.earliestContact.t);
  assert.ok(Math.abs(r.earliestContact.temp - (20 + 5 / 12 * DT)) < 1e-6);
  // 接触点在两坯体中心连线上的边界处（x=50）
  assert.ok(Math.abs(r.earliestContact.point.x - 50) < 1e-6);
  assert.ok(Math.abs(r.earliestContact.point.y - 50) < 1e-6);
});

test('间隙足够大时目标温度内无接触', () => {
  const r = analyze(basePlan([mk('a', { cx: 20, cy: 50 }), mk('b', { cx: 80, cy: 50 })]));
  assert.strictEqual(r.earliestContact, null);
  assert.strictEqual(r.contacts.length, 0);
});

test('旋转矩形 45° 方块：SAT 斜向角部接触（起始不接触）', () => {
  // 两块 45° 旋转方块，沿斜轴法向 (1,1)/√2 方向错开。
  // 斜轴上每块投影半宽 = 5√2 ≈ 7.071；沿该法向中心距设为 14.2（间隙 ≈ 0.0586），
  // 故中心取 (50±14.2/2·1/√2, 50±14.2/2·1/√2)。
  const d = 14.2 / 2 / Math.SQRT2;
  const ax = round6(50 - d);
  const bx = round6(50 + d);
  const a = mk('a', { cx: ax, cy: ax, angle: 45 });
  const b = mk('b', { cx: bx, cy: bx, angle: 45 });
  const r = analyze(basePlan([a, b]));
  const hit = r.contacts.find((c) => c.kind === 'body');
  assert.ok(hit, '应检测到接触');
  assert.ok(!hit.preContact && hit.t > 0 && hit.t <= 1, '应在升温过程中接触，t=' + hit.t);
  // 闭合时沿斜轴 2*hw(s)*√2 = 实际中心距（沿斜轴）
  const s = 1 + 10e-6 * DT * hit.t;
  const distDiag = (bx - ax) * Math.SQRT2; // 沿 (1,1)/√2 方向的中心距
  assert.ok(Math.abs(2 * 5 * s * Math.SQRT2 - distDiag) < 1e-6);
  const tExpect = (distDiag / (2 * 5 * Math.SQRT2) - 1) / (10e-6 * DT);
  assert.ok(Math.abs(hit.t - tExpect) < 1e-7, 't=' + hit.t + ' expect=' + tExpect);
});

test('旋转 45° 方块水平并排：水平中心距需 ≥ 宽投影 10√2 才分离', () => {
  // 经典结果：45° 方块水平投影宽度 10√2 ≈ 14.142
  const sep = analyze(basePlan([
    mk('a', { cx: round6(50 - 7.1), cy: 50, angle: 45 }),
    mk('b', { cx: round6(50 + 7.1), cy: 50, angle: 45 }),
  ]));
  // 中心距 14.2 > 14.142 但斜轴投影要求水平距 20，故实际起始仍重叠 → preContact
  assert.ok(sep.earliestContact && sep.earliestContact.preContact,
    '45° 方块水平中心距 14.2 在斜轴上仍重叠');
  const far = analyze(basePlan([
    mk('a', { cx: 39.5, cy: 50, angle: 45 }),
    mk('b', { cx: 60.5, cy: 50, angle: 45 }),
  ]));
  // 水平中心距 21：斜轴投影 14.85，间隙 0.71 > 全行程膨胀 0.17 → 不接触
  assert.strictEqual(far.earliestContact, null);
});

function round6(v) { return Math.round(v * 1e6) / 1e6; }

test('旋转矩形不同角度：取两条不同 SAT 轴中闭合最晚者', () => {
  // 一个水平、一个 30°（直接调底层函数，角度用弧度）；间隙 0.05cm
  const a = { ...mk('a', { cx: 44.975, cy: 50, angle: 0 }), alpha: 10e-6 };
  const b = { ...mk('b', { cx: 55.025, cy: 50, angle: 30 * Math.PI / 180 }), alpha: 10e-6 };
  const hit = contactBodyBody(a, b, DT);
  assert.ok(hit);
  assert.ok(hit.t > 0 && hit.t <= 1);
  // 手工枚举所有轴的闭合时刻，验证实现取的是最大值
  const axes = [[1, 0], [0, 1], [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)], [-Math.sin(Math.PI / 6), Math.cos(Math.PI / 6)]];
  let tMax = 0;
  for (const [nx, ny] of axes) {
    const r1 = 5 * (Math.abs(nx) + Math.abs(ny));
    const r2 = 5 * (Math.abs(nx) + Math.abs(ny));
    const sep0 = Math.abs(10.05 * nx) - (r1 + r2);
    if (sep0 > 0) tMax = Math.max(tMax, sep0 / ((r1 + r2) * 10e-6 * DT));
  }
  assert.ok(Math.abs(hit.t - Math.min(1, tMax)) < 1e-9);
});

test('窑壁接触：膨胀后右壁先接触，温度解析正确', () => {
  // 10×10，右壁间隙 0.05cm；α=10e-6，单侧全行程膨胀 0.06cm
  // t* = 0.05 / 0.06 = 5/6
  const r = analyze(basePlan([mk('a', { cx: 94.95, cy: 50, alpha: 10 })]));
  assert.ok(r.earliestContact, '应检测到右壁接触');
  assert.strictEqual(r.earliestContact.kind, 'wall');
  assert.strictEqual(r.earliestContact.wallId, 'right');
  assert.ok(Math.abs(r.earliestContact.t - 5 / 6) < 1e-9);
  assert.ok(Math.abs(r.earliestContact.temp - (20 + 5 / 6 * DT)) < 1e-6);
});

test('间隙 1cm、α=10：目标温度内不接触窑壁', () => {
  const r = analyze(basePlan([mk('a', { cx: 94, cy: 50, alpha: 10 })]));
  assert.strictEqual(r.earliestContact, null);
});

test('起始已重叠：t=0 标记 preContact 并高亮两个坯体', () => {
  const r = analyze(basePlan([mk('a', { cx: 49.5, cy: 50 }), mk('b', { cx: 50.5, cy: 50 })]));
  assert.ok(r.earliestContact);
  assert.strictEqual(r.earliestContact.preContact, true);
  assert.strictEqual(r.earliestContact.t, 0);
  assert.deepStrictEqual(r.highlightBodyIds.slice().sort(), ['a', 'b']);
});

test('起始即越出窑壁：t=0 的壁接触', () => {
  const r = analyze(basePlan([mk('a', { cx: 96, cy: 50 })]));
  const wall = r.contacts.find((c) => c.kind === 'wall');
  assert.ok(wall);
  assert.strictEqual(wall.preContact, true);
  assert.deepStrictEqual(r.highlightWallIds, ['right']);
});

test('α=0 且有间隙：永远不接触', () => {
  const r = analyze(basePlan([mk('a', { cx: 44.975, cy: 50, alpha: 0 }), mk('b', { cx: 55.025, cy: 50, alpha: 0 })]));
  assert.strictEqual(r.earliestContact, null);
});

test('非法参数：目标温度不高于起始温度时报错', () => {
  const r = analyze(basePlan([mk('a')], { tempTarget: 20 }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.join('').includes('目标温度'));
  // 错误路径也必须返回完整字段，前端渲染依赖这些字段
  assert.deepStrictEqual(r.contacts, []);
  assert.deepStrictEqual(r.highlightBodyIds, []);
  assert.deepStrictEqual(r.highlightWallIds, []);
  assert.deepStrictEqual(r.firstTouch, {});
  assert.strictEqual(r.earliestContact, null);
});

test('不同 α 的两个坯体：闭合速率为两侧投影速率之和', () => {
  // 间隙 0.05cm；rate = 5*20e-6*1200 + 5*10e-6*1200 = 0.12 + 0.06 = 0.18
  const r = analyze(basePlan([
    mk('a', { cx: 44.975, cy: 50, alpha: 20 }),
    mk('b', { cx: 55.025, cy: 50, alpha: 10 }),
  ]));
  assert.ok(r.earliestContact);
  assert.ok(Math.abs(r.earliestContact.t - 0.05 / 0.18) < 1e-9);
});

test('多对接触：最早接触取全局最小值且只高亮涉事对象', () => {
  // A-B 在 5/12 接触；C 紧贴右壁在更早（0.02/0.06=1/3）接触
  const r = analyze(basePlan([
    mk('a', { cx: 44.975, cy: 50 }),
    mk('b', { cx: 55.025, cy: 50 }),
    mk('c', { cx: 94.98, cy: 20, alpha: 10 }),
  ]));
  assert.strictEqual(r.contacts.length >= 2, true);
  assert.strictEqual(r.earliestContact.kind, 'wall');
  assert.strictEqual(r.earliestContact.bodyIds[0], 'c');
  assert.deepStrictEqual(r.highlightBodyIds, ['c']);
  assert.deepStrictEqual(r.highlightWallIds, ['right']);
});

console.log(`\n${passed} 个测试通过`);
