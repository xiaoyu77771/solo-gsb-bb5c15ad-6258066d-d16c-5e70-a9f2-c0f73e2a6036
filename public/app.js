/* 陶艺装窑预检 —— 前端交互与画布渲染 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const canvas = $('kiln-canvas');
  const ctx = canvas.getContext('2d');

  const WALL_NAMES = { left: '左壁', right: '右壁', top: '后壁', bottom: '前壁' };
  const HANDLE_R = 8;          // 旋转手柄半径（屏幕像素）
  const HANDLE_STEM = 26;      // 手柄距坯体顶边（屏幕像素）

  let plan = null;
  let analysis = null;
  let selectedId = null;
  let selectedContactIdx = null;
  let view = { scale: 4, ox: 0, oy: 0 };

  // 指针交互状态
  let drag = null; // { mode:'move'|'rotate', pointerId, startX, startY, orig... }

  let saveTimer = null;
  let saveSeq = 0;

  /* ---------- 持久化 ---------- */

  async function loadPlan() {
    setSaveStatus('加载中…', 'saving');
    const res = await fetch('/api/plan');
    if (!res.ok) throw new Error('加载方案失败');
    plan = await res.json();
    setSaveStatus('已加载（未修改）', 'saved');
  }

  async function savePlan(silent) {
    if (!plan) return;
    const seq = ++saveSeq;
    setSaveStatus('保存中…', 'saving');
    try {
      const res = await fetch('/api/plan', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(plan),
      });
      if (!res.ok) throw new Error((await res.json()).error || '保存失败');
      if (seq === saveSeq) {
        const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        setSaveStatus(silent ? `已自动保存 ${t}` : `已保存 ${t}`, 'saved');
      }
    } catch (err) {
      if (seq === saveSeq) setSaveStatus('保存失败：' + err.message, 'error');
    }
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => savePlan(true), 600);
  }

  function setSaveStatus(text, cls) {
    const el = $('save-status');
    el.textContent = text;
    el.className = 'save-status ' + (cls || '');
  }

  /* ---------- 变更 -> 重算 -> 重绘 ---------- */

  function recompute() {
    analysis = window.KilnPhysics.analyze(plan);
    if (selectedContactIdx !== null && selectedContactIdx >= analysis.contacts.length) {
      selectedContactIdx = null;
    }
  }

  function refresh({ save = true } = {}) {
    recompute();
    renderAll();
    if (save) scheduleSave();
  }

  function renderAll() {
    renderErrors();
    renderResult();
    renderBodyList();
    renderProps();
    drawCanvas();
    renderContacts();
  }

  /* ---------- 画布坐标 ---------- */

  function fitView() {
    if (!plan || !(plan.kiln.width > 0) || !(plan.kiln.depth > 0)) return;
    const wrap = canvas.parentElement;
    const cssW = wrap.clientWidth;
    const cssH = Math.max(380, Math.min(680, Math.round(cssW * plan.kiln.depth / plan.kiln.width)));
    const dpr = window.devicePixelRatio || 1;
    canvas.style.height = cssH + 'px';
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const pad = 46;
    const scale = Math.min((cssW - pad * 2) / plan.kiln.width, (cssH - pad * 2) / plan.kiln.depth);
    view.scale = scale;
    view.ox = (cssW - plan.kiln.width * scale) / 2;
    // 画布 y 向下，窑室 y 向后（向上），做垂直翻转
    view.oy = (cssH + plan.kiln.depth * scale) / 2;
  }

  function cmToScreen(x, y) {
    return { x: view.ox + x * view.scale, y: view.oy - y * view.scale };
  }

  function screenToCm(x, y) {
    return { x: (x - view.ox) / view.scale, y: (view.oy - y) / view.scale };
  }

  /* ---------- 绘制 ---------- */

  function drawCanvas() {
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    ctx.clearRect(0, 0, W, H);
    // 方案未加载或窑室尺寸非法时只显示错误横幅，不绘制
    if (!plan || !analysis || !(plan.kiln.width > 0) || !(plan.kiln.depth > 0)) return;

    drawGrid(W, H);
    drawKiln();

    const involvedIds = analysis.highlightBodyIds;

    // 目标温度外廓（虚线，先画在底层）
    for (const b of plan.bodies) drawBodyOutline(b, 1, { dashed: true });

    // 起始温度实体外廓；涉事对象的起始轮廓只描边，避免压住红色接触轮廓
    for (const b of plan.bodies) {
      if (involvedIds.includes(b.id)) {
        drawBodyOutline(b, 0, { selected: b.id === selectedId, outlineOnly: true });
      } else {
        drawBodyOutline(b, 0, { fill: true, selected: b.id === selectedId });
      }
    }

    // 最早接触时刻的涉事坯体外廓（红）
    if (analysis.earliestContact) {
      const c = analysis.earliestContact;
      for (const id of c.bodyIds) {
        const b = plan.bodies.find((x) => x.id === id);
        if (b) drawBodyOutline(b, c.t, { contact: true });
      }
    }

    // 坯体名称（接触时刻尺寸，随坯体旋转）
    for (const b of plan.bodies) {
      const t = involvedIds.includes(b.id) && analysis.earliestContact ? analysis.earliestContact.t : 0;
      drawBodyLabel(b, t);
    }

    // 选中手柄
    const sel = selectedBody();
    if (sel) drawHandles(sel);

    // 接触点
    analysis.contacts.forEach((c, i) => drawContactMarker(c, i));
  }

  function drawGrid(W, H) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.font = '10px sans-serif';
    const step = 10;
    for (let x = 0; x <= plan.kiln.width + 1e-6; x += step) {
      const p = cmToScreen(x, 0), q = cmToScreen(x, plan.kiln.depth);
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
      ctx.fillText(x + '', p.x - 6, p.y + 14);
    }
    for (let y = 0; y <= plan.kiln.depth + 1e-6; y += step) {
      const p = cmToScreen(0, y), q = cmToScreen(plan.kiln.width, y);
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
      if (y > 0) ctx.fillText(y + '', p.x - 26, p.y + 3);
    }
    ctx.restore();
  }

  function drawKiln() {
    const p0 = cmToScreen(0, 0);
    const p1 = cmToScreen(plan.kiln.width, plan.kiln.depth);
    const x = p1.x, y = p1.y, w = p0.x - p1.x, h = p0.y - p1.y;

    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    ctx.fillRect(x, y, w, h);

    const wallLines = {
      left:   [x, y, x, y + h],
      right:  [x + w, y, x + w, y + h],
      top:    [x, y, x + w, y],
      bottom: [x, y + h, x + w, y + h],
    };
    for (const [id, coords] of Object.entries(wallLines)) {
      const hot = analysis.highlightWallIds.includes(id);
      ctx.beginPath();
      ctx.moveTo(coords[0], coords[1]); ctx.lineTo(coords[2], coords[3]);
      ctx.lineWidth = hot ? 5 : 2.5;
      ctx.strokeStyle = hot ? '#e05c50' : 'rgba(217,138,61,0.85)';
      ctx.stroke();
    }

    ctx.fillStyle = 'rgba(217,138,61,0.7)';
    ctx.font = '11px sans-serif';
    ctx.fillText(`${plan.kiln.width} cm`, x + w / 2 - 16, y + h + 22);
    ctx.save();
    ctx.translate(x - 28, y + h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(`${plan.kiln.depth} cm`, -16, 0);
    ctx.restore();
    ctx.restore();
  }

  function scaledDims(b, t) {
    const span = plan.tempTarget - plan.tempStart;
    const k = Number.isFinite(span) ? 1 + (b.alpha || 0) * 1e-6 * t * span : 1;
    return { w: b.w * k, h: b.h * k };
  }

  function traceBody(b, t) {
    const { w, h } = scaledDims(b, t);
    const c = cmToScreen(b.cx, b.cy);
    ctx.translate(c.x, c.y);
    ctx.rotate(-b.angle * Math.PI / 180); // 屏幕 y 翻转，角度取负
    ctx.beginPath();
    ctx.rect(-w * view.scale / 2, -h * view.scale / 2, w * view.scale, h * view.scale);
  }

  function drawBodyOutline(b, t, opts) {
    opts = opts || {};
    const involved = !!opts.contact;
    ctx.save();
    traceBody(b, t);

    if (opts.dashed) {
      ctx.strokeStyle = 'rgba(201,160,90,0.9)';
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (involved) {
      ctx.fillStyle = 'rgba(224,92,80,0.38)';
      ctx.fill();
      ctx.strokeStyle = '#e05c50';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    } else {
      ctx.fillStyle = 'rgba(107,143,113,0.45)';
      if (opts.fill) ctx.fill();
      ctx.strokeStyle = opts.selected ? '#e8c07d' : 'rgba(143,191,151,0.95)';
      ctx.lineWidth = opts.selected ? 2.4 : 1.5;
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawBodyLabel(b, t) {
    const { w } = scaledDims(b, t);
    if (w * view.scale < 34) return; // 太小不标
    const c = cmToScreen(b.cx, b.cy);
    ctx.save();
    ctx.translate(c.x, c.y);
    // 标签始终正向显示在坯体中心，便于阅读
    ctx.fillStyle = 'rgba(255,255,255,0.78)';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(b.name || '', 0, 3.5);
    ctx.restore();
  }

  function handlePos(b) {
    const c = cmToScreen(b.cx, b.cy);
    const a = -b.angle * Math.PI / 180;
    const topY = b.h * view.scale / 2;
    const d = topY + HANDLE_STEM;
    return { x: c.x + Math.sin(a) * d, y: c.y - Math.cos(a) * d };
  }

  function drawHandles(b) {
    const c = cmToScreen(b.cx, b.cy);
    const a = -b.angle * Math.PI / 180;
    const topY = b.h * view.scale / 2;
    const h = handlePos(b);

    ctx.save();
    ctx.strokeStyle = 'rgba(232,192,125,0.8)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(c.x + Math.sin(a) * topY, c.y - Math.cos(a) * topY);
    ctx.lineTo(h.x, h.y);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(h.x, h.y, HANDLE_R, 0, Math.PI * 2);
    ctx.fillStyle = '#e8c07d';
    ctx.fill();
    ctx.strokeStyle = '#8a5a2c';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // 四角缩放不提供；中心点提示
    ctx.beginPath();
    ctx.arc(c.x, c.y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(232,192,125,0.9)';
    ctx.fill();
    ctx.restore();
  }

  function drawContactMarker(c, idx) {
    const p = cmToScreen(c.point.x, c.point.y);
    const earliest = analysis.earliestContact === c;
    const selected = idx === selectedContactIdx;
    ctx.save();
    if (earliest) {
      const pulse = 7 + Math.sin(Date.now() / 300) * 1.2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, pulse, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(224,92,80,0.6)';
      ctx.lineWidth = 2;
      ctx.stroke();

      drawStar(p.x, p.y, 6, '#ff6b5e');

      const label = c.preContact ? '起始已接触' : `最早接触 ${formatTemp(c.temp)}°C`;
      ctx.font = 'bold 12px sans-serif';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(74,36,32,0.92)';
      roundRect(p.x + 10, p.y - 22, tw + 14, 20, 4);
      ctx.fill();
      ctx.fillStyle = '#ffd2cc';
      ctx.textAlign = 'left';
      ctx.fillText(label, p.x + 17, p.y - 8);
    } else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(224,92,80,0.75)';
      ctx.fill();
    }
    if (selected) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 12, 0, Math.PI * 2);
      ctx.strokeStyle = '#e8c07d';
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawStar(x, y, r, color) {
    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const rr = i % 2 === 0 ? r : r * 0.45;
      const ang = -Math.PI / 2 + (i * Math.PI) / 5;
      const px = x + Math.cos(ang) * rr, py = y + Math.sin(ang) * rr;
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ---------- 命中测试 ---------- */

  function pointInBody(b, px, py) {
    const cm = screenToCm(px, py);
    const dx = cm.x - b.cx, dy = cm.y - b.cy;
    const a = -b.angle * Math.PI / 180;
    const lx = dx * Math.cos(a) - dy * Math.sin(a);
    const ly = dx * Math.sin(a) + dy * Math.cos(a);
    return Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2;
  }

  function hitBody(px, py) {
    for (let i = plan.bodies.length - 1; i >= 0; i--) {
      if (pointInBody(plan.bodies[i], px, py)) return plan.bodies[i];
    }
    return null;
  }

  function hitHandle(b, px, py) {
    if (!b) return false;
    const h = handlePos(b);
    return Math.hypot(px - h.x, py - h.y) <= HANDLE_R + 4;
  }

  /* ---------- 指针交互 ---------- */

  canvas.addEventListener('pointerdown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const sel = selectedBody();

    if (sel && hitHandle(sel, px, py)) {
      drag = { mode: 'rotate', pointerId: e.pointerId };
      canvas.style.cursor = 'grabbing';
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    const b = hitBody(px, py);
    selectBody(b ? b.id : null);
    if (b) {
      drag = {
        mode: 'move',
        pointerId: e.pointerId,
        startPx: px, startPy: py,
        origCx: b.cx, origCy: b.cy,
        bodyId: b.id,
      };
      canvas.style.cursor = 'grabbing';
      canvas.setPointerCapture(e.pointerId);
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;

    if (!drag) {
      const sel = selectedBody();
      if (sel && hitHandle(sel, px, py)) canvas.style.cursor = 'crosshair';
      else canvas.style.cursor = hitBody(px, py) ? 'grab' : 'default';
      return;
    }

    if (drag.mode === 'move') {
      const b = plan.bodies.find((x) => x.id === drag.bodyId);
      b.cx = round1(drag.origCx + (px - drag.startPx) / view.scale);
      b.cy = round1(drag.origCy - (py - drag.startPy) / view.scale);
    } else if (drag.mode === 'rotate') {
      const b = selectedBody();
      const c = cmToScreen(b.cx, b.cy);
      // 手柄局部方向为 (0,-1)，世界角 = 体角度 - 90°
      const ang = Math.atan2(py - c.y, px - c.x) * 180 / Math.PI + 90;
      b.angle = Math.round(normAngle(ang));
    }
    recompute();
    renderAll();
  });

  const endDrag = (e) => {
    if (drag) {
      drag = null;
      canvas.style.cursor = '';
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      scheduleSave();
    }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  /* ---------- UI：窑室/温度 ---------- */

  $('kiln-w').addEventListener('input', (e) => {
    if (!plan) return;
    plan.kiln.width = Number(e.target.value); refresh();
  });
  $('kiln-d').addEventListener('input', (e) => {
    if (!plan) return;
    plan.kiln.depth = Number(e.target.value); refresh();
  });
  $('temp-start').addEventListener('input', (e) => {
    if (!plan) return;
    plan.tempStart = Number(e.target.value); refresh();
  });
  $('temp-target').addEventListener('input', (e) => {
    if (!plan) return;
    plan.tempTarget = Number(e.target.value); refresh();
  });

  $('btn-add').addEventListener('click', () => {
    const w = Number($('new-w').value), h = Number($('new-h').value);
    const alpha = Number($('new-alpha').value);
    const angle = Number($('new-angle').value) || 0;
    let name = $('new-name').value.trim();
    if (!name) name = '坯体 ' + (plan.bodies.length + 1);
    if (!(w > 0) || !(h > 0) || !(alpha >= 0)) {
      alert('请填写合法的宽、高与线膨胀系数');
      return;
    }
    const b = {
      id: 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      name, w, h, alpha, angle: normAngle(angle),
      cx: round1(plan.kiln.width / 2),
      cy: round1(plan.kiln.depth / 2),
    };
    plan.bodies.push(b);
    $('new-name').value = '';
    selectBody(b.id);
    refresh();
  });

  $('btn-save').addEventListener('click', () => savePlan(false));
  $('btn-reset').addEventListener('click', async () => {
    if (!confirm('恢复为内置示例方案？当前方案将被覆盖。')) return;
    const res = await fetch('/api/plan/reset', { method: 'POST' });
    plan = await res.json();
    selectBody(null);
    fitView();
    refresh({ save: false });
    setSaveStatus('已恢复示例方案', 'saved');
  });

  /* ---------- UI：坯体列表 / 属性 ---------- */

  function renderBodyList() {
    const ul = $('body-list');
    ul.innerHTML = '';
    for (const b of plan.bodies) {
      const li = document.createElement('li');
      if (b.id === selectedId) li.classList.add('selected');
      if (analysis.highlightBodyIds.includes(b.id)) li.classList.add('involved');
      const t = analysis.firstTouch && analysis.firstTouch[b.id] !== undefined
        ? formatTemp(plan.tempStart + analysis.firstTouch[b.id] * (plan.tempTarget - plan.tempStart))
        : null;
      li.innerHTML = `<span class="dot"></span><span>${escapeHtml(b.name)}</span>` +
        `<span class="meta">${t !== null ? t + '°C接触' : '安全'} · ${b.angle}°</span>`;
      li.addEventListener('click', () => selectBody(b.id));
      ul.appendChild(li);
    }
  }

  function renderProps() {
    const b = selectedBody();
    $('props-panel').hidden = !b;
    if (!b) return;
    setVal('prop-name', b.name);
    setVal('prop-w', b.w);
    setVal('prop-h', b.h);
    setVal('prop-alpha', b.alpha);
    setVal('prop-cx', b.cx);
    setVal('prop-cy', b.cy);
    const slider = $('prop-angle');
    if (document.activeElement !== slider) slider.value = b.angle;
    $('prop-angle-val').textContent = Math.round(b.angle) + '°';
  }

  function setVal(id, v) {
    const el = $(id);
    if (document.activeElement !== el) el.value = v;
  }

  function bindProp(id, fn) {
    $(id).addEventListener('input', () => {
      const b = selectedBody();
      if (b) { fn(b); refresh(); }
    });
  }
  bindProp('prop-name', (b) => { b.name = $('prop-name').value; });
  bindProp('prop-w', (b) => { b.w = Number($('prop-w').value); });
  bindProp('prop-h', (b) => { b.h = Number($('prop-h').value); });
  bindProp('prop-alpha', (b) => { b.alpha = Number($('prop-alpha').value); });
  bindProp('prop-cx', (b) => { b.cx = Number($('prop-cx').value); });
  bindProp('prop-cy', (b) => { b.cy = Number($('prop-cy').value); });
  bindProp('prop-angle', (b) => { b.angle = Number($('prop-angle').value); });

  $('btn-rotate-l').addEventListener('click', () => rotateSelected(-15));
  $('btn-rotate-r').addEventListener('click', () => rotateSelected(15));
  $('btn-delete').addEventListener('click', deleteSelected);

  document.addEventListener('keydown', (e) => {
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) { e.preventDefault(); deleteSelected(); }
    if (e.key === 'ArrowLeft' && selectedId) { e.preventDefault(); rotateSelected(e.shiftKey ? -1 : -15); }
    if (e.key === 'ArrowRight' && selectedId) { e.preventDefault(); rotateSelected(e.shiftKey ? 1 : 15); }
  });

  function rotateSelected(delta) {
    const b = selectedBody();
    if (!b) return;
    b.angle = normAngle(b.angle + delta);
    refresh();
  }

  function deleteSelected() {
    plan.bodies = plan.bodies.filter((b) => b.id !== selectedId);
    selectBody(null);
    refresh();
  }

  function selectedBody() {
    return plan && plan.bodies.find((b) => b.id === selectedId) || null;
  }

  function selectBody(id) {
    selectedId = id;
    selectedContactIdx = null;
    renderBodyList();
    renderProps();
    drawCanvas();
    renderContacts();
  }

  function normAngle(a) {
    a = ((a + 180) % 360 + 360) % 360 - 180;
    return Math.round(a * 100) / 100;
  }

  /* ---------- 结果区 ---------- */

  function renderErrors() {
    const el = $('canvas-errors');
    if (analysis.ok) {
      el.hidden = true;
      el.textContent = '';
    } else {
      el.hidden = false;
      el.innerHTML = analysis.errors.map(escapeHtml).join('<br>');
    }
  }

  function renderResult() {
    const card = $('result-card');
    const val = $('result-value');
    const sub = $('result-sub');
    card.classList.remove('safe', 'unsafe');

    if (!analysis.ok) {
      card.classList.add('unsafe');
      val.textContent = '参数有误';
      sub.textContent = analysis.errors.join('；');
      return;
    }
    const c = analysis.earliestContact;
    if (!c) {
      card.classList.add('safe');
      val.textContent = `✓ 目标 ${formatTemp(plan.tempTarget)}°C 内无接触`;
      sub.textContent = `共 ${plan.bodies.length} 件坯体，可安全升温至目标温度`;
      return;
    }
    card.classList.add('unsafe');
    if (c.preContact) {
      val.textContent = '⚠ 起始状态已接触/越界';
    } else {
      val.textContent = `⚠ 最早接触温度 ${formatTemp(c.temp)}°C`;
    }
    const names = c.kind === 'body'
      ? c.bodyIds.map(bodyName).join(' 与 ')
      : `${bodyName(c.bodyIds[0])} 与${WALL_NAMES[c.wallId]}`;
    const extra = c.preContact
      ? '请先在画布上调整摆位'
      : `升温 ${formatTemp(c.temp - plan.tempStart)}°C 后发生接触`;
    sub.textContent = `${names} —— ${extra}`;
  }

  function renderContacts() {
    const tbody = $('contacts-tbody');
    tbody.innerHTML = '';
    if (!analysis.contacts.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="7">目标温度内未检测到任何接触</td></tr>';
      return;
    }
    analysis.contacts.forEach((c, i) => {
      const tr = document.createElement('tr');
      if (analysis.earliestContact === c) tr.classList.add('earliest');
      if (i === selectedContactIdx) tr.classList.add('selected-row');
      const typeBadge = c.kind === 'body'
        ? '<span class="badge body">坯体—坯体</span>'
        : '<span class="badge wall">坯体—窑壁</span>';
      const preBadge = c.preContact ? ' <span class="badge pre">起始已接触</span>' : '';
      const who = c.kind === 'body'
        ? c.bodyIds.map(bodyName).join(' / ')
        : `${bodyName(c.bodyIds[0])} → ${WALL_NAMES[c.wallId]}`;
      tr.innerHTML =
        `<td>${i + 1}</td>` +
        `<td>${typeBadge}${preBadge}</td>` +
        `<td>${escapeHtml(who)}</td>` +
        `<td>${c.preContact ? '—' : formatTemp(c.temp) + ' °C'}</td>` +
        `<td>${c.preContact ? '—' : formatTemp(c.temp - plan.tempStart) + ' °C'}</td>` +
        `<td>(${formatTemp(c.point.x)}, ${formatTemp(c.point.y)})</td>` +
        `<td>${analysis.earliestContact === c ? '🔴 最早' : ''}</td>`;
      tr.addEventListener('click', () => {
        selectedContactIdx = selectedContactIdx === i ? null : i;
        renderContacts();
        drawCanvas();
      });
      tbody.appendChild(tr);
    });
  }

  function bodyName(id) {
    const b = plan.bodies.find((x) => x.id === id);
    return b ? b.name : id;
  }

  /* ---------- 工具 ---------- */

  function formatTemp(v) {
    if (Math.abs(v - Math.round(v)) < 0.05) return String(Math.round(v));
    return v.toFixed(1);
  }
  function round1(v) { return Math.round(v * 10) / 10; }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
  }

  /* ---------- 初始化 ---------- */

  function syncFormFromPlan() {
    $('kiln-w').value = plan.kiln.width;
    $('kiln-d').value = plan.kiln.depth;
    $('temp-start').value = plan.tempStart;
    $('temp-target').value = plan.tempTarget;
  }

  let pulseTimer = null;
  function startPulse() {
    clearInterval(pulseTimer);
    pulseTimer = setInterval(() => { if (analysis && analysis.earliestContact) drawCanvas(); }, 120);
  }

  window.addEventListener('resize', () => { fitView(); drawCanvas(); });
  new ResizeObserver(() => { fitView(); drawCanvas(); }).observe(canvas.parentElement);

  (async function init() {
    await loadPlan();
    syncFormFromPlan();
    fitView();
    recompute();
    renderAll();
    startPulse();
  })().catch((err) => {
    setSaveStatus('初始化失败：' + err.message, 'error');
    console.error(err);
  });
})();
