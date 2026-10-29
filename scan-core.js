'use strict';
// สแกนโฟลเดอร์ 1 แห่งรอบเดียว แล้วแบ่งไฟล์ตามวัน และรอบเที่ยง/ค่ำ
// ฟังก์ชันนี้ต้องไม่อ้างถึงตัวแปรภายนอก เพราะถูกส่งไปรันใน worker thread
function scanRange({ root, from, to, win }) {
  const fs = require('fs');
  const path = require('path');
  try {
    if (!fs.statSync(root).isDirectory()) return { error: 'ไม่ใช่โฟลเดอร์' };
  } catch (e) {
    return { error: 'เข้าถึง path ไม่ได้' };
  }
  const parts = (s) => s.split('-').map(Number);
  const [fy, fm, fd] = parts(from);
  const [ty, tm, td] = parts(to);
  const start = new Date(fy, fm - 1, fd).getTime();
  const end = new Date(ty, tm - 1, td + 1).getTime();
  const pad = (n) => (n < 10 ? '0' : '') + n;
  const days = {};
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue;
      let st;
      try {
        st = fs.statSync(full);
      } catch (e) {
        continue;
      }
      const t = st.mtimeMs;
      if (t < start || t >= end) continue;
      const d = new Date(t);
      const sec = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
      let round = null;
      if (sec >= win.noon[0] && sec < win.noon[1]) round = 'noon';
      else if (sec >= win.evening[0] && sec < win.evening[1]) round = 'evening';
      if (!round) continue;
      const key = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      const b = days[key] || (days[key] = { noon: [0, 0], evening: [0, 0] });
      b[round][0] += 1;
      b[round][1] += st.size;
    }
  }
  return { days };
}

module.exports = { scanRange };
