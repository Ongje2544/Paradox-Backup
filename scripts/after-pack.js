'use strict';
// ใส่ไอคอนและข้อมูลเวอร์ชันลงในไฟล์ .exe โดยไม่ต้องใช้ rcedit/wine/สิทธิ์ Administrator
const fs = require('fs');
const path = require('path');
const ResEdit = require('resedit');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  try {
    setIconAndVersion(context);
  } catch (e) {
    // ถ้าใส่ไอคอนไม่สำเร็จ ให้ build ต่อได้ (exe จะใช้ไอคอน Electron ปกติ)
    console.warn('  • after-pack: could not set exe icon:', e && e.message);
  }
};

function setIconAndVersion(context) {
  const appInfo = context.packager.appInfo;
  const exeName = appInfo.productFilename + '.exe';
  const exePath = path.join(context.appOutDir, exeName);
  const icoPath = path.join(context.packager.projectDir, 'assets', 'icon.ico');

  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);

  // ไอคอน: แทนที่ icon group แรกของ electron.exe
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
  const icons = iconFile.icons.map((i) => i.data);
  if (groups.length) {
    for (const g of groups) {
      ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, g.id, g.lang, icons);
    }
  } else {
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, icons);
  }

  // ข้อมูลเวอร์ชัน (ชื่อที่ Windows แสดงใน Task Manager / Properties)
  const vis = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  if (vis.length) {
    const vi = vis[0];
    const ver = String(appInfo.version).split('.').map(Number);
    while (ver.length < 4) ver.push(0);
    vi.setFileVersion(...ver);
    vi.setProductVersion(...ver);
    const langs = vi.getAllLanguagesForStringValues();
    const lang = langs.length ? langs[0] : { lang: 1033, codepage: 1200 };
    vi.setStringValues(lang, {
      ProductName: appInfo.productName,
      FileDescription: appInfo.productName,
      CompanyName: appInfo.productName,
      InternalName: appInfo.productName,
      OriginalFilename: exeName,
      LegalCopyright: '',
      FileVersion: appInfo.version,
      ProductVersion: appInfo.version,
    });
    vi.outputToResourceEntries(res.entries);
  }

  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log('  • after-pack: set icon and version info on', exeName);
}
