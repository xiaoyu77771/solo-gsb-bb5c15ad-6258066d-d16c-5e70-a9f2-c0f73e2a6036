/*
 * 装窑预检核心物理/碰撞模块（无浏览器依赖，可被 Node 测试直接引用）
 *
 * 热膨胀模型：
 *   s(T) = 1 + alpha * (T - T0)          alpha 为线膨胀系数（单位 1/°C）
 *   坯体中心与旋转角不随温度变化，宽/高等比线性放大。
 *
 * 接触检测：
 *   旋转矩形之间使用分离轴定理 SAT（4 条候选法向 = 两个矩形各自的两条轴向）；
 *   窑壁为轴对齐直线，直接向 x/y 法向投影。
 *   所有投影半宽均为温升 t 的线性函数，间隙 gap(t)=gap0-rate*t，
 *   最早闭合（所有轴向同时闭合）的时刻即最早接触温度。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.KilnPhysics = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EPS = 1e-9; // cm，视为已接触的间隙容差

  function bodyAxes(angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return [
      { x: c, y: s },   // 局部 X 轴
      { x: -s, y: c },  // 局部 Y 轴
    ];
  }

  /* 半宽 hw、半高 hh 的旋转矩形在单位轴 n 上的投影半宽 */
  function support(hw, hh, n) {
    return hw * Math.abs(n.x) + hh * Math.abs(n.y);
  }

  function dot(a, b) {
    return a.x * b.x + a.y * b.y;
  }

  function scaleBody(b, t) {
    return {
      id: b.id,
      cx: b.cx,
      cy: b.cy,
      w: b.w * (1 + b.alpha * t),
      h: b.h * (1 + b.alpha * t),
      angle: b.angle,
      alpha: b.alpha,
    };
  }

  /* 温度增量 ΔT（°C）-> 温升参数 t（t=0 为起始温度，t=1 为目标温度） */
  function tempAt(t, plan) {
    return plan.tempStart + t * (plan.tempTarget - plan.tempStart);
  }

  /*
   * 两个旋转矩形坯体的最早接触。
   * 返回 { t, point, normal } 或 null（目标温度内不接触）。
   * SAT：各候选轴上的间隙均为 t 的线性函数；全部轴同时闭合才算接触，
   * 故取闭合时刻 tAxis 的最大值；若某轴在目标温度内不闭合则永不接触。
   */
  function contactBodyBody(b1, b2, dTemp) {
    dTemp = dTemp || 1; // 目标-起始温差（°C）
    const hw1 = b1.w / 2, hh1 = b1.h / 2;
    const hw2 = b2.w / 2, hh2 = b2.h / 2;
    const axes = bodyAxes(b1.angle).concat(bodyAxes(b2.angle));

    // 去除平行（含反向）的重复轴
    const uniq = [];
    for (const a of axes) {
      if (!uniq.some((u) => Math.abs(dot(u, a)) > 1 - 1e-9)) uniq.push(a);
    }

    const delta = { x: b2.cx - b1.cx, y: b2.cy - b1.cy };
    let closeT = 0;
    let bestAxis = null;
    let overlapAxis = null;
    let maxOverlapGap = -Infinity;
    let anySeparated = false;

    for (const n of uniq) {
      const r1 = support(hw1, hh1, n);
      const r2 = support(hw2, hh2, n);
      const dist = Math.abs(dot(delta, n));
      const sep0 = dist - (r1 + r2); // >0：该轴分离；≤0：该轴重叠（|sep0| 为侵入量）
      const rate = (r1 * b1.alpha + r2 * b2.alpha) * dTemp; // 全温程投影增量

      if (sep0 > EPS) {
        // 分离轴：间隙随温升线性减小
        anySeparated = true;
        if (rate <= EPS) return null; // 不膨胀，永不接触
        const tAxis = sep0 / rate;
        if (tAxis > closeT) {
          closeT = tAxis;
          bestAxis = n;
        }
      } else {
        // 该轴在起始温度即重叠，记录侵入最浅者作为推出法向
        if (sep0 > maxOverlapGap) {
          maxOverlapGap = sep0;
          overlapAxis = n;
        }
      }
    }

    // 所有轴在起始温度都重叠：起始即相互侵入
    if (!anySeparated) {
      const n = overlapAxis || { x: 1, y: 0 };
      const nn = dot(delta, n) < 0 ? { x: -n.x, y: -n.y } : n;
      return { t: 0, point: contactPointBodyBody(b1, b2, nn, 0), normal: nn, preContact: true };
    }

    if (closeT > 1 + 1e-7) return null;

    // closeT 由闭合最晚的轴决定；法向统一指向 b1 -> b2
    let n = bestAxis;
    if (dot(delta, n) < 0) n = { x: -n.x, y: -n.y };
    const point = contactPointBodyBody(b1, b2, n, closeT, dTemp);
    return { t: Math.max(0, Math.min(1, closeT)), point, normal: n };
  }

  function contactPointBodyBody(b1, b2, n, t, dTemp) {
    const s1 = scaleBodyAt(b1, t, dTemp);
    const s2 = scaleBodyAt(b2, t, dTemp);
    const r1 = support(s1.w / 2, s1.h / 2, n);
    const r2 = support(s2.w / 2, s2.h / 2, n);
    return {
      x: (b1.cx + n.x * r1 + b2.cx - n.x * r2) / 2,
      y: (b1.cy + n.y * r1 + b2.cy - n.y * r2) / 2,
    };
  }

  function scaleBodyAt(b, t, dTemp) {
    dTemp = dTemp === undefined ? 1 : dTemp;
    const k = 1 + b.alpha * dTemp * t;
    return { w: b.w * k, h: b.h * k };
  }

  /* 坯体与窑壁的最早接触。dTemp = 目标-起始温差（°C） */
  function contactWalls(body, kiln, dTemp) {
    dTemp = dTemp || 1;
    const hw = body.w / 2, hh = body.h / 2;
    const walls = [
      { id: 'right', n: { x: 1, y: 0 }, gap0: kiln.width - body.cx - support(hw, hh, { x: 1, y: 0 }) },
      { id: 'left', n: { x: -1, y: 0 }, gap0: body.cx - support(hw, hh, { x: -1, y: 0 }) },
      { id: 'top', n: { x: 0, y: 1 }, gap0: kiln.depth - body.cy - support(hw, hh, { x: 0, y: 1 }) },
      { id: 'bottom', n: { x: 0, y: -1 }, gap0: body.cy - support(hw, hh, { x: 0, y: -1 }) },
    ];

    const hits = [];
    for (const w of walls) {
      const r = support(hw, hh, w.n);
      if (w.gap0 <= EPS) {
        hits.push({
          wallId: w.id,
          t: 0,
          preContact: true,
          normal: w.n,
          point: { x: body.cx + w.n.x * r, y: body.cy + w.n.y * r },
        });
        continue;
      }
      const rate = r * body.alpha * dTemp;
      if (rate > EPS) {
        const t = w.gap0 / rate;
        if (t <= 1 + 1e-7) {
          const rt = r * (1 + body.alpha * dTemp * t);
          hits.push({
            wallId: w.id,
            t: Math.max(0, Math.min(1, t)),
            normal: w.n,
            point: { x: body.cx + w.n.x * rt, y: body.cy + w.n.y * rt },
          });
        }
      }
    }
    // 同一坯体可能起始即越界多面，全部保留但按 t 排序
    hits.sort((a, b) => a.t - b.t);
    return hits;
  }

  /*
   * 完整预检。
   * plan: { kiln:{width,depth}, tempStart, tempTarget, bodies:[{id,name,w,h,cx,cy,angle,alpha}] }
   * alpha 输入约定为 ×10^-6 /°C（界面数值），内部换算为 1/°C。
   */
  function analyze(plan) {
    const errors = [];
    const kiln = plan.kiln || {};
    if (!(kiln.width > 0) || !(kiln.depth > 0)) errors.push('窑室宽/深必须为正数');
    if (typeof plan.tempStart !== 'number' || typeof plan.tempTarget !== 'number') {
      errors.push('起始/目标温度缺失');
    } else if (plan.tempTarget <= plan.tempStart) {
      errors.push('目标温度必须高于起始温度');
    }
    if (errors.length) {
      return {
        ok: false, errors, contacts: [], earliestContact: null,
        firstTouch: {}, highlightBodyIds: [], highlightWallIds: [],
      };
    }

    // 界面输入 alpha（如 8.0 表示 8×10^-6/°C）换算成 1/°C；角度换算成弧度
    const bodies = (plan.bodies || []).map((b) => ({
      ...b,
      alpha: (Number(b.alpha) || 0) * 1e-6,
      angle: (Number(b.angle) || 0) * Math.PI / 180,
    }));

    const span = plan.tempTarget - plan.tempStart;
    const contacts = [];

    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (!(b.w > 0 && b.h > 0)) {
        errors.push(`坯体「${b.name || b.id}」的宽/高必须为正数`);
        continue;
      }
      for (const hit of contactWalls(b, kiln, span)) {
        contacts.push({
          kind: 'wall',
          bodyIds: [b.id],
          wallId: hit.wallId,
          t: hit.t,
          temp: plan.tempStart + hit.t * span,
          preContact: !!hit.preContact,
          point: hit.point,
          normal: hit.normal,
        });
      }
      for (let j = i + 1; j < bodies.length; j++) {
        const hit = contactBodyBody(b, bodies[j], span);
        if (hit) {
          contacts.push({
            kind: 'body',
            bodyIds: [b.id, bodies[j].id],
            t: hit.t,
            temp: plan.tempStart + hit.t * span,
            preContact: !!hit.preContact,
            point: hit.point,
            normal: hit.normal,
          });
        }
      }
    }

    contacts.sort((a, b) => a.t - b.t);
    const earliestContact = contacts.length ? contacts[0] : null;

    // 每个坯体各自的最早接触
    const firstTouch = {};
    for (const c of contacts) {
      for (const id of c.bodyIds) {
        if (firstTouch[id] === undefined || c.t < firstTouch[id]) firstTouch[id] = c.t;
      }
    }

    return {
      ok: errors.length === 0,
      errors,
      contacts,
      earliestContact,
      firstTouch,
      highlightBodyIds: earliestContact ? earliestContact.bodyIds.slice() : [],
      highlightWallIds: earliestContact && earliestContact.kind === 'wall'
        ? [earliestContact.wallId] : [],
    };
  }

  return { analyze, scaleBody, tempAt, contactBodyBody, contactWalls, EPS };
});
