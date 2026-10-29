'use strict';
const api = window.paradox;
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const GB = 1073741824;
const TH_DOW = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
const TH_DOW_FULL = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
const TH_MON = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
let S = null, day = null, timer = null, busy = false, pending = null, stripKey = '';

/* ---------- helpers ---------- */
async function call(p) {
  const r = await p;
  if (r && r.error) throw new Error(r.error);
  return r;
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 3200);
}
const fgb = (b) => (b / GB).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const parseDay = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const pad = (n) => String(n).padStart(2, '0');
const dayStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (s, n) => { const d = parseDay(s); d.setDate(d.getDate() + n); return dayStr(d); };
const fullDate = (s) => { const d = parseDay(s); return `วัน${TH_DOW_FULL[d.getDay()]}ที่ ${d.getDate()} ${TH_MON[d.getMonth()]} ${d.getFullYear()}`; };

// น้อยกว่าวันก่อน = less (เขียว), มากกว่า = more (แดง)
const trend = (cur, prev) => (cur < prev ? 'less' : cur > prev ? 'more' : 'same');
function delta(cur, prev) {
  const d = cur - prev;
  const cls = trend(cur, prev);
  const sg = d > 0 ? '▲' : d < 0 ? '▼' : '■';
  const pct = prev > 0 ? (d / prev * 100 >= 0 ? '+' : '') + (d / prev * 100).toFixed(1) + '%' : (cur > 0 ? 'ใหม่' : '0%');
  return { cls, txt: `${sg} ${d >= 0 ? '+' : '-'}${fgb(Math.abs(d))} GB (${pct})` };
}
function countTo(el, to, dec, suffix) {
  const t0 = performance.now(), dur = 900;
  (function f(t) {
    const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 4), v = to * e;
    el.textContent = (dec ? v.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : Math.round(v).toLocaleString('en')) + (suffix || '');
    if (k < 1) requestAnimationFrame(f);
  })(t0);
}
const sum = (r, p) => {
  let c = 0, b = 0;
  S.sources.forEach((s) => { c += s[p][r][0]; b += s[p][r][1]; });
  return [c, b];
};
function lowReason(d) {
  if (!d) return null;
  const pct = d.total ? d.used / d.total * 100 : 0;
  if (d.free < S.warn.free_gb * GB) return `เหลือเพียง ${fgb(d.free)} GB (ต่ำกว่า ${S.warn.free_gb} GB)`;
  if (pct >= S.warn.used_pct) return `ใช้ไปแล้ว ${pct.toFixed(1)}% (เกิน ${S.warn.used_pct}%)`;
  return null;
}
function uniqueDrives() {
  const seen = new Set(), list = [];
  S.sources.forEach((s) => {
    const k = s.drive.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    list.push(s);
  });
  return list;
}

/* ---------- day picker ---------- */
function dotClass(okCount, date, round) {
  if (!S.n) return 'none';
  if (date === S.today && S.now_sec < S.win_sec[round][0]) return 'wait';
  return okCount >= S.n ? 'ok' : okCount > 0 ? 'warn' : 'bad';
}
function renderStrip() {
  const key = S.strip[0].date + S.strip[S.strip.length - 1].date;
  const strip = $('#strip');
  strip.classList.toggle('still', key === stripKey);   // เล่นแอนิเมชันเฉพาะตอนช่วงวันเปลี่ยน
  stripKey = key;
  const max = Math.max(1, ...S.strip.map((x) => x.noon[1] + x.evening[1]));
  strip.innerHTML = S.strip.map((x, i) => {
    const d = parseDay(x.date), tot = x.noon[1] + x.evening[1];
    const h = tot ? Math.max(10, tot / max * 100) : 0;
    const p = S.strip[i - 1], ptot = p ? p.noon[1] + p.evening[1] : null;
    const tr = p ? trend(tot, ptot) : 'same';
    const tip = `${fullDate(x.date)}\nรอบเที่ยง: ${x.noon[0].toLocaleString('en')} ไฟล์ / ${fgb(x.noon[1])} GB\nรอบค่ำ: ${x.evening[0].toLocaleString('en')} ไฟล์ / ${fgb(x.evening[1])} GB`
      + (p ? `\nเทียบวันก่อน: ${delta(tot, ptot).txt}` : '');
    return `<button class="day ${x.date === S.day ? 'sel' : ''} ${x.date === S.today ? 'today' : ''}" data-date="${x.date}" style="--d:${i * 25}ms" title="${esc(tip)}">
      <span class="dow">${x.date === S.today ? 'วันนี้' : TH_DOW[d.getDay()]}</span>
      <span class="dnum">${d.getDate()}</span>
      <span class="mon">${TH_MON[d.getMonth()]}</span>
      <span class="mini"><i class="${tr}" style="height:${h}%"></i></span>
      <span class="dots"><b class="${dotClass(x.noonOk, x.date, 'noon')}"></b><b class="${dotClass(x.eveOk, x.date, 'evening')}"></b></span>
    </button>`;
  }).join('');
  const sel = strip.querySelector('.sel');
  if (sel) sel.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  $('#next').disabled = S.day >= S.today;
  $('#today').disabled = S.day === S.today;
  const pick = $('#pick');
  pick.max = S.today;
  pick.value = S.day;
  $('#dateline').textContent = fullDate(S.day) + (S.is_today ? ' (วันนี้)' : '');
}

/* ---------- render ---------- */
function renderDash() {
  const n = { cur: sum('noon', 'cur'), prev: sum('noon', 'prev') };
  const e = { cur: sum('evening', 'cur'), prev: sum('evening', 'prev') };
  const t = {
    cur: [n.cur[0] + e.cur[0], n.cur[1] + e.cur[1]],
    prev: [n.prev[0] + e.prev[0], n.prev[1] + e.prev[1]],
  };
  const defs = [
    ['☀ รอบเที่ยง', n, S.windows.noon.join(' - '), ''],
    ['☾ รอบค่ำ', e, S.windows.evening.join(' - '), ''],
    ['✦ รวมทั้งหมด', t, 'เที่ยง + ค่ำ', 'total'],
  ];
  $('#cards').innerHTML = defs.map(([title, x, win, cls], i) => {
    const d = delta(x.cur[1], x.prev[1]), df = x.cur[0] - x.prev[0];
    return `<div class="card spot ${cls} ${d.cls}" style="--d:${i * 110}ms"><i class="lit"></i><div class="ctitle">${title}<span class="win">${win}</span></div>
      <div class="big" data-n="${x.cur[0]}">0</div><div class="lbl">ไฟล์</div>
      <div class="size" data-g="${x.cur[1] / GB}">0.00 GB</div>
      <span class="chip ${d.cls}">เทียบวันก่อน ${d.txt}</span>
      <div class="sub">ไฟล์ ${df >= 0 ? '+' : ''}${df.toLocaleString('en')} · วันก่อน ${x.prev[0].toLocaleString('en')} ไฟล์ / ${fgb(x.prev[1])} GB</div></div>`;
  }).join('');
  $$('#cards .big').forEach((el) => countTo(el, +el.dataset.n, false));
  $$('#cards .size').forEach((el) => countTo(el, +el.dataset.g, true, ' GB'));

  const names = { noon: 'เที่ยง', evening: 'ค่ำ' };
  $('#rows').innerHTML = S.sources.map((s, i) => {
    let cls, txt;
    if (s.error) { cls = 'bad'; txt = '✘ ' + s.error; }
    else {
      const wait = (r) => S.is_today && S.now_sec < S.win_sec[r][0];
      const miss = ['noon', 'evening'].filter((r) => s.cur[r][0] === 0 && !wait(r));
      const wt = ['noon', 'evening'].filter(wait);
      if (!miss.length && !wt.length) { cls = 'ok'; txt = '✔ ครบทั้ง 2 รอบ'; }
      else if (miss.length) { cls = miss.length === 2 ? 'bad' : 'warn'; txt = '✘ ไม่พบรอบ' + miss.map((r) => names[r]).join('/'); }
      else { cls = 'wait'; txt = '⏳ รอรอบ' + wt.map((r) => names[r]).join('/'); }
    }
    return `<tr style="--d:${i * 60}ms"><td><b>${esc(s.machine)}</b></td><td style="color:var(--muted)">${esc(s.path)}</td>
      <td class="n">${s.cur.noon[0].toLocaleString('en')}</td><td class="n">${fgb(s.cur.noon[1])}</td>
      <td class="n">${s.cur.evening[0].toLocaleString('en')}</td><td class="n">${fgb(s.cur.evening[1])}</td>
      <td><span class="pill ${cls}">${esc(txt)}</span></td></tr>`;
  }).join('');
  $('#rowsEmpty').innerHTML = S.sources.length ? '' : '<div class="empty"><b>✦</b>ยังไม่มีเครื่องที่ต้องเช็ค — ไปที่เมนู "เครื่อง / โฟลเดอร์" เพื่อเพิ่ม</div>';
}

function renderDisks() {
  const list = uniqueDrives();
  const lows = [];
  $('#disks').innerHTML = list.length ? list.map((s, i) => {
    if (!s.disk) {
      lows.push(`<b>${esc(s.machine)}</b> (${esc(s.drive)}): อ่านพื้นที่ไม่ได้`);
      return `<div class="disk low" style="--d:${i * 100}ms"><div class="t"><span>${esc(s.machine)} (${esc(s.drive)})</span><span style="color:var(--bad)">อ่านพื้นที่ไม่ได้</span></div></div>`;
    }
    const p = s.disk.total ? s.disk.used / s.disk.total * 100 : 0;
    const reason = lowReason(s.disk);
    if (reason) lows.push(`<b>${esc(s.machine)}</b> (${esc(s.drive)}): ${reason}`);
    const c = reason ? 'hi' : p > 75 ? 'mid' : '';
    return `<div class="disk spot ${reason ? 'low' : ''}" style="--d:${i * 100}ms"><i class="lit"></i><div class="t"><span>${esc(s.machine)} (${esc(s.drive)})</span><span>${p.toFixed(1)}% ใช้แล้ว</span></div>
      <div class="track"><div class="fill ${c}" data-w="${p}"></div></div>
      <div class="m"><span>ใช้ไป <b>${fgb(s.disk.used)} GB</b></span><span>ว่าง <b>${fgb(s.disk.free)} GB</b></span><span>ทั้งหมด <b>${fgb(s.disk.total)} GB</b></span></div>
      ${reason ? `<div class="warnTxt">⚠ ดิสก์ใกล้เต็ม: ${reason}</div>` : ''}</div>`;
  }).join('') : '<div class="empty"><b>◉</b>ยังไม่มีข้อมูล — เพิ่มโฟลเดอร์ก่อน</div>';
  setTimeout(() => $$('.fill').forEach((f) => { f.style.width = f.dataset.w + '%'; }), 60);

  $('#alert').hidden = lows.length === 0;
  $('#alertTxt').innerHTML = lows.length ? '<b>แจ้งเตือนดิสก์</b><br>' + lows.join('<br>') : '';
  $('#badge').hidden = lows.length === 0;
  $('#badge').textContent = lows.length;
}

async function renderSrc() {
  const c = await api.config();
  $('#srcRows').innerHTML = c.sources.map((s, i) => `<tr style="--d:${i * 60}ms"><td><b>${esc(s.machine)}</b></td><td style="color:var(--muted)">${esc(s.path)}</td>
    <td><button class="btn danger" data-del="${i}">✕ ลบ</button></td></tr>`).join('');
  $('#srcEmpty').innerHTML = c.sources.length ? '' : '<div class="empty"><b>⛁</b>ยังไม่มีรายการ</div>';
  $('#ns').value = c.noon[0]; $('#ne').value = c.noon[1];
  $('#es').value = c.evening[0]; $('#ee').value = c.evening[1];
  $('#rf').value = c.refresh_min; $('#wf').value = c.warn_free_gb; $('#wp').value = c.warn_used_pct;
  $('#auto').checked = !!c.autostart;
}

/* ---------- load ---------- */
async function load(force) {
  if (busy) { pending = { force: pending ? pending.force || !!force : !!force }; return; }
  busy = true;
  $('#bar').classList.add('on');
  $('#dot').classList.add('busy');
  $('#status').textContent = force ? 'กำลังสแกนใหม่...' : 'กำลังโหลด...';
  try {
    S = await call(api.data(day, force));
    day = S.day;
    renderStrip();
    renderDash();
    renderDisks();
    $('#status').textContent = 'อัปเดตล่าสุด ' + new Date().toLocaleTimeString('th-TH');
    clearInterval(timer);
    timer = setInterval(() => { if (!document.hidden) load(true); }, S.refresh_min * 60000);
  } catch (e) {
    toast('เกิดข้อผิดพลาด: ' + e.message);
    $('#status').textContent = 'ผิดพลาด';
  }
  $('#bar').classList.remove('on');
  $('#dot').classList.remove('busy');
  busy = false;
  if (pending) { const p = pending; pending = null; load(p.force); }
}
function setDay(d) {
  if (!d) return;
  if (S && d > S.today) d = S.today;
  if (d === day && S && S.day === d) return;
  day = d;
  if (S) {   // ไฮไลต์ทันทีก่อนข้อมูลมา ให้รู้สึกตอบสนองไว
    $$('#strip .day').forEach((b) => b.classList.toggle('sel', b.dataset.date === d));
    $('#dateline').textContent = fullDate(d);
  }
  load(false);
}
const shift = (n) => day && setDay(addDays(day, n));

function go(page) {
  if (!$('#p-' + page)) page = 'dash';
  $$('nav button').forEach((x) => x.classList.toggle('active', x.dataset.p === page));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === 'p-' + page));
  if (page === 'src') renderSrc();
  if (page === 'disk' && S) renderDisks();
}

/* ---------- events ---------- */
$('#prev').onclick = () => shift(-1);
$('#next').onclick = () => shift(1);
$('#today').onclick = () => S && setDay(S.today);
$('#scan').onclick = () => load(true);
$('#pick').onchange = (e) => setDay(e.target.value);
$('#strip').onclick = (e) => { const b = e.target.closest('.day'); if (b) setDay(b.dataset.date); };
$('#strip').addEventListener('wheel', (e) => {
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { e.currentTarget.scrollLeft += e.deltaY; e.preventDefault(); }
}, { passive: false });
document.addEventListener('keydown', (e) => {
  if (!$('#p-dash').classList.contains('active')) return;
  if (e.target.closest('input')) return;
  if (e.key === 'ArrowLeft') { shift(-1); e.preventDefault(); }
  else if (e.key === 'ArrowRight') { shift(1); e.preventDefault(); }
  else if (e.key === 'Home' && S) { setDay(S.today); e.preventDefault(); }
  else if (e.key === 'F5') { load(true); e.preventDefault(); }
});
$$('nav button').forEach((b) => { b.onclick = () => go(b.dataset.p); });
api.onGoto((p) => { go(p); load(false); });

$('#browse').onclick = async () => {
  const p = await api.pickFolder();
  if (p) $('#fp').value = p;
};
$('#add').onclick = async () => {
  try {
    const r = await call(api.addSource({ machine: $('#fm').value, path: $('#fp').value }));
    $('#fm').value = ''; $('#fp').value = '';
    toast(r.reachable ? 'เพิ่มเรียบร้อย ✦' : 'เพิ่มแล้ว แต่ตอนนี้เข้าถึง path ไม่ได้');
    await renderSrc();
    load(true);
  } catch (e) { toast(e.message); }
};
$('#srcRows').onclick = async (e) => {
  const b = e.target.closest('[data-del]');
  if (!b) return;
  try {
    await call(api.delSource(+b.dataset.del));
    toast('ลบแล้ว');
    await renderSrc();
    load(false);
  } catch (err) { toast(err.message); }
};
$('#save').onclick = async () => {
  try {
    await call(api.saveSettings({
      noon: [$('#ns').value, $('#ne').value],
      evening: [$('#es').value, $('#ee').value],
      refresh_min: $('#rf').value,
      warn_free_gb: $('#wf').value,
      warn_used_pct: $('#wp').value,
      autostart: $('#auto').checked,
    }));
    toast('บันทึกแล้ว ✦');
    load(true);
  } catch (e) { toast(e.message); }
};
$('#testNote').onclick = () => api.testNotify();

document.addEventListener('click', (e) => {
  const b = e.target.closest('button.btn');
  if (!b || b.disabled) return;
  const r = document.createElement('span'), s = Math.max(b.clientWidth, b.clientHeight), q = b.getBoundingClientRect();
  r.className = 'ripple';
  r.style.cssText = `width:${s}px;height:${s}px;left:${e.clientX - q.left - s / 2}px;top:${e.clientY - q.top - s / 2}px`;
  b.appendChild(r);
  setTimeout(() => r.remove(), 600);
});
// แสงตามเมาส์: อัปเดตแค่ครั้งเดียวต่อเฟรม และใช้ transform/ตัวแปร CSS เท่านั้น จึงตามเมาส์ทันทีไม่หน่วง
(function () {
  const g = $('#glow');
  let last = null, frame = 0;
  const apply = () => {
    frame = 0;
    const e = last;
    g.style.transform = `translate3d(${e.clientX}px,${e.clientY}px,0)`;
    const s = e.target instanceof Element && e.target.closest('.spot');
    if (s) {
      const r = s.getBoundingClientRect();
      s.style.setProperty('--mx', e.clientX - r.left + 'px');
      s.style.setProperty('--my', e.clientY - r.top + 'px');
    }
  };
  addEventListener('pointermove', (e) => { last = e; if (!frame) frame = requestAnimationFrame(apply); }, { passive: true });
})();

/* ---------- starfield ---------- */
(function () {
  const c = $('#stars'), x = c.getContext('2d');
  let W, H, P = [];
  const rs = () => {
    W = c.width = innerWidth; H = c.height = innerHeight;
    P = Array.from({ length: Math.min(110, (W * H / 15000) | 0) }, () => ({
      x: Math.random() * W, y: Math.random() * H, r: Math.random() * 1.7 + .3,
      vx: (Math.random() - .5) * .18, vy: -Math.random() * .25 - .05,
      p: Math.random() * 6.28, g: Math.random() < .35, rune: Math.random() < .05,
    }));
  };
  addEventListener('resize', rs);
  rs();
  const R = 'ᚠᚢᚦᚨᚱᚲᚷᚹᚺᚾᛁᛃ';
  // วาดดาวเรืองแสงไว้ล่วงหน้าเป็นภาพเล็ก แล้วแปะซ้ำ (shadowBlur ทุกดวงทุกเฟรมช้ามาก)
  const sprite = (col) => {
    const c2 = document.createElement('canvas'), g2 = c2.getContext('2d');
    c2.width = c2.height = 32;
    const gr = g2.createRadialGradient(16, 16, 0, 16, 16, 16);
    gr.addColorStop(0, `rgba(${col},1)`); gr.addColorStop(.18, `rgba(${col},.9)`); gr.addColorStop(.45, `rgba(${col},.25)`); gr.addColorStop(1, `rgba(${col},0)`);
    g2.fillStyle = gr; g2.fillRect(0, 0, 32, 32);
    return c2;
  };
  const SP = [sprite('140,198,255'), sprite('190,200,255'), sprite('240,215,160')];
  const RC = ['140,198,255', '190,200,255', '240,215,160'];
  (function f(t) {
    if (!document.hidden) {
      x.clearRect(0, 0, W, H);
      for (const s of P) {
        s.x += s.vx; s.y += s.vy;
        if (s.y < -10) { s.y = H + 10; s.x = Math.random() * W; }
        if (s.x < -10) s.x = W + 10;
        if (s.x > W + 10) s.x = -10;
        const a = .35 + .65 * Math.abs(Math.sin(t / 1200 + s.p)), k = s.g ? 0 : s.p > 5.6 ? 2 : 1;
        if (s.rune) { x.globalAlpha = a * .5; x.font = '16px serif'; x.fillStyle = `rgb(${RC[k]})`; x.fillText(R[(s.p * 100 | 0) % R.length], s.x, s.y); }
        else { const z = s.r * 7; x.globalAlpha = a; x.drawImage(SP[k], s.x - z / 2, s.y - z / 2, z, z); }
      }
      x.globalAlpha = 1;
    }
    requestAnimationFrame(f);
  })(0);
})();

go(new URLSearchParams(location.search).get('page') || 'dash');
load(false);
