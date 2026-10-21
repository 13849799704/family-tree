/**
 * =========================================================
 * 照片模块自测 · tests/photos.test.js
 * ---------------------------------------------------------
 * 直接 `node tests/photos.test.js`，**不需要 Electron**：
 *   photoNames.js 是纯函数；photoStore.js 只依赖 fs/path，
 *   nativeImage 以参数注入（这里给桩）—— 与 db.test.js 同一思路。
 *
 * 覆盖：
 *   1. 命名与校验纯函数（安全口径：路径逃逸必须被挡住）
 *   2. 引用收集（导出 / 缺失报数共用）
 *   3. photoStore 编排：添加（含拒绝分支）、读、删、恢复
 * =========================================================
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  PHOTO_EXTS, isValidPhotoName, safeExt, mimeOfExt, extOfName,
  sanitizePersonId, rand6, photoName, thumbName, collectPhotoRefs, missingPhotoRefs,
} from '../src/core/photoNames.js';
import {
  addPhotos, readDataUrl, readMany, removePhotos, restoreMap, squareThumb,
} from '../electron/photoStore.js';

/* ========================================================= */
/* 极简测试框架（与 tests/db.test.js 同款）                      */
/* ========================================================= */

let passed = 0;
const failures = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e) {
    failures.push({ group: currentGroup, name, message: e.message });
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      \x1b[31m${String(e.message).split('\n')[0]}\x1b[0m`);
  }
}

/* ========================================================= */
/* 临时沙箱                                                    */
/* ========================================================= */

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'genogram_phototest_'));
const cleanup = () => {
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* 忽略 */ }
};
process.on('exit', cleanup);

/**
 * 桩 nativeImage：
 *   · 内容以 BAD 开头 → 判为「解码失败」
 *   · 尺寸从字节头的 "WxH" 读出来 —— 这样「方形 / 非方形」才测得出来
 *     （缩略图必须是方的，理由见 electron/photoStore.js 的注释）
 *   · 生成的字节也把尺寸写在头里（"320x320:PNG"），好让桩自己认得出方形
 */
const nativeImageStub = {
  createFromBuffer: (buf) => {
    if (buf.slice(0, 3).toString() === 'BAD') return { isEmpty: () => true };
    const m = /^(\d+)x(\d+)/.exec(buf.slice(0, 12).toString());
    const size = m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 640, height: 480 };
    const encoders = (width, height) => ({
      toJPEG: () => Buffer.from(`${width}x${height}:JPEG`),
      toPNG: () => Buffer.from(`${width}x${height}:PNG`),
    });
    return {
      isEmpty: () => false,
      getSize: () => size,
      /* crop 的返回值也是一张图：带 getSize / resize / 编码器（真 nativeImage 就是这样） */
      crop: (r) => {
        const cropped = {
          ...encoders(r.width, r.height),
          getSize: () => ({ width: r.width, height: r.height }),
          resize: ({ width, height }) => encoders(width, height),
        };
        return cropped;
      },
      resize: ({ width, height }) => encoders(width, height),
    };
  },
};

/** 造一个 1×1 真 PNG（addPhotos 只走桩，不需要真能解码） */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/* ========================================================= */
/* 1. 纯函数：命名与校验                                        */
/* ========================================================= */

group('1. 命名与校验纯函数');

await test('safeExt 认白名单、转小写、挡掉其余', () => {
  assert.equal(safeExt('a.JPG'), 'jpg');
  assert.equal(safeExt('a.jpeg'), 'jpeg');
  assert.equal(safeExt('a.webp'), 'webp');
  assert.equal(safeExt('a.txt'), null);
  assert.equal(safeExt('noext'), null);
  assert.equal(safeExt(''), null);
  assert.equal(safeExt(null), null);
});

await test('isValidPhotoName 挡掉一切路径逃逸形态', () => {
  // 合法的
  assert.equal(isValidPhotoName('p_me-a1b2c3.jpg'), true);
  assert.equal(isValidPhotoName('p_me-a1b2c3.thumb.png'), true);
  assert.equal(isValidPhotoName('A9.jpg'), true);
  // 分隔符
  assert.equal(isValidPhotoName('a/b.jpg'), false);
  assert.equal(isValidPhotoName('a\\b.jpg'), false);
  assert.equal(isValidPhotoName('..\\..\\genogram.db'), false);
  // 绝对路径 / 相对上级
  assert.equal(isValidPhotoName('C:\\x.jpg'), false);
  assert.equal(isValidPhotoName('../x.jpg'), false);
  assert.equal(isValidPhotoName('..'), false);
  assert.equal(isValidPhotoName('..x'), false);
  // 连续点 / 空 / 非 ASCII / 前导点
  assert.equal(isValidPhotoName('a..b.jpg'), false);
  assert.equal(isValidPhotoName(''), false);
  assert.equal(isValidPhotoName('照片.jpg'), false);
  assert.equal(isValidPhotoName('.hidden'), false);
  assert.equal(isValidPhotoName(null), false);
  assert.equal(isValidPhotoName(42), false);
});

await test('sanitizePersonId 只留字母数字，空串兜底 p', () => {
  assert.equal(sanitizePersonId('p_me'), 'pme');
  assert.equal(sanitizePersonId('p  me!'), 'pme');
  assert.equal(sanitizePersonId(''), 'p');
  assert.equal(sanitizePersonId(null), 'p');
  assert.equal(sanitizePersonId('../../etc'), 'etc');
});

await test('photoName 形如 <personId>-<rand6>.<ext>', () => {
  const n = photoName('p_me', 'JPG');
  assert.match(n, /^pme-[0-9a-f]{6}\.jpg$/);
  assert.match(photoName('p_wus', 'png'), /^pwus-[0-9a-f]{6}\.png$/);
  // 随机性：连出两个不一样
  assert.notEqual(photoName('p_me', 'jpg'), photoName('p_me', 'jpg'));
  assert.match(rand6(), /^[0-9a-f]{6}$/);
});

await test('thumbName 在扩展名前插 .thumb', () => {
  assert.equal(thumbName('p_me-a1b2c3.jpg'), 'p_me-a1b2c3.thumb.jpg');
  assert.equal(thumbName('x.png'), 'x.thumb.png');
  assert.equal(thumbName('x'), 'x');   // 无扩展名：原样返回（真实照片必有扩展名）
});

await test('mimeOfExt / extOfName 配套', () => {
  assert.equal(mimeOfExt('jpg'), 'image/jpeg');
  assert.equal(mimeOfExt('jpeg'), 'image/jpeg');
  assert.equal(mimeOfExt('png'), 'image/png');
  assert.equal(mimeOfExt('webp'), 'image/webp');
  assert.equal(mimeOfExt('gif'), 'image/gif');
  assert.equal(mimeOfExt('bmp'), 'image/bmp');
  assert.equal(extOfName('p_me-a1.JPG'), 'jpg');
  assert.equal(extOfName('noext'), '');
});

/* ========================================================= */
/* 2. 纯函数：引用收集                                          */
/* ========================================================= */

group('2. 引用收集（导出 / 缺失报数共用）');

await test('collectPhotoRefs 收 photos + avatar，去且保序', () => {
  const ds = {
    people: [
      { id: 'a', avatar: 'a.jpg', photos: ['a.jpg', 'b.jpg', ''] },
      { id: 'b', avatar: '', photos: ['b.jpg', 'c.png'] },
      { id: 'c', avatar: 'd.png', photos: null },
    ],
  };
  assert.deepEqual(collectPhotoRefs(ds), ['a.jpg', 'b.jpg', 'c.png', 'd.png']);
  assert.deepEqual(collectPhotoRefs({}), []);
  assert.deepEqual(collectPhotoRefs(null), []);
});

await test('missingPhotoRefs 按判据报缺失', () => {
  const ds = { people: [{ id: 'a', avatar: 'a.jpg', photos: ['b.jpg', 'c.png'] }] };
  const has = (n) => n === 'a.jpg' || n === 'c.png';
  assert.deepEqual(missingPhotoRefs(ds, has), ['b.jpg']);
});

/* ========================================================= */
/* 3. photoStore 编排（临时目录 + 桩 nativeImage）                */
/* ========================================================= */

group('3. photoStore 编排');

/** 每例一个干净目录，互不干扰 */
let caseNo = 0;
const freshDir = () => {
  const d = path.join(sandbox, `case_${++caseNo}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

await test('addPhotos：好文件入库（含缩略图），坏文件逐个拒绝', () => {
  const dir = freshDir();
  const src = path.join(sandbox, 'src');
  fs.mkdirSync(src, { recursive: true });
  const good = path.join(src, 'good.png');
  fs.writeFileSync(good, PNG_1PX);
  const bad = path.join(src, 'bad.jpg');
  fs.writeFileSync(bad, Buffer.from('BAD-not-an-image'));
  const txt = path.join(src, 'note.txt');
  fs.writeFileSync(txt, 'hello');
  const gone = path.join(src, 'missing.png');

  const r = addPhotos(dir, 'p_me', [good, bad, txt, gone], nativeImageStub);

  assert.equal(r.ok, true);
  assert.equal(r.added.length, 1);
  assert.match(r.added[0], /^pme-[0-9a-f]{6}\.png$/);
  // 原字节落盘 + 缩略图落盘（png 走 toPNG 桩）
  assert.ok(fs.existsSync(path.join(dir, r.added[0])));
  assert.equal(
    fs.readFileSync(path.join(dir, r.added[0])).equals(PNG_1PX), true,
    '存的是原文件字节，不是重编码的'
  );
  const thumb = path.join(dir, r.added[0].replace(/\.png$/, '.thumb.png'));
  assert.ok(fs.existsSync(thumb), '缩略图已生成');
  // png 走 toPNG；缩略图是方形 320×320（桩把尺寸写在字节头里）
  assert.equal(fs.readFileSync(thumb).toString(), '320x320:PNG');

  // 三个拒绝理由各就位
  assert.equal(r.rejected.length, 3);
  const byFile = Object.fromEntries(r.rejected.map((x) => [path.basename(x.file), x.reason]));
  assert.match(byFile['bad.jpg'], /解码失败/);
  assert.match(byFile['note.txt'], /格式不支持/);
  assert.match(byFile['missing.png'], /读不了/);
});

await test('addPhotos：jpg 走 toJPEG，缩略图是**方形中心裁切** 320×320', () => {
  const dir = freshDir();
  const src = path.join(sandbox, 'src2');
  fs.mkdirSync(src, { recursive: true });
  const f = path.join(src, 'big.jpg');
  fs.writeFileSync(f, PNG_1PX);
  const r = addPhotos(dir, 'p_me', [f], nativeImageStub);
  const thumb = path.join(dir, r.added[0].replace(/\.jpg$/, '.thumb.jpg'));
  // 640×480 → 中心裁 480×480 → 缩到 320×320（方图进方框，导出时才不会被拉扁）
  assert.equal(fs.readFileSync(thumb).toString(), '320x320:JPEG');
});

await test('squareThumb：旧版非方形缩略图就地重生成成方的', () => {
  const dir = freshDir();
  const name = 'pme-abc123.png';
  fs.writeFileSync(path.join(dir, name), Buffer.from('640x480:ORIG'));
  // 旧版缩略图 = 等比缩放（640×480，非方形）
  fs.writeFileSync(path.join(dir, 'pme-abc123.thumb.png'), Buffer.from('640x480:LEGACY'));

  const r = squareThumb(dir, name, nativeImageStub);
  assert.equal(r.ok, true);
  assert.equal(r.thumb, true);
  assert.match(r.dataUrl, /^data:image\/png;base64,/);
  // 重生成后落盘的缩略图是方的
  assert.equal(fs.readFileSync(path.join(dir, 'pme-abc123.thumb.png')).toString(), '320x320:PNG');
});

await test('squareThumb：已是方形的缩略图直接读，不重生成', () => {
  const dir = freshDir();
  const name = 'pme-abc123.png';
  fs.writeFileSync(path.join(dir, name), Buffer.from('640x480:ORIG'));
  fs.writeFileSync(path.join(dir, 'pme-abc123.thumb.png'), Buffer.from('320x320:PNG'));

  const r = squareThumb(dir, name, nativeImageStub);
  assert.equal(r.ok, true);
  assert.equal(
    Buffer.from(r.dataUrl.split(',')[1], 'base64').toString(), '320x320:PNG',
    '读到的就是磁盘上那份，没被重写'
  );
});

await test('squareThumb：原图不在 → 报缺失，不硬造', () => {
  const dir = freshDir();
  const r = squareThumb(dir, 'pme-none.png', nativeImageStub);
  assert.equal(r.ok, false);
  assert.match(r.error, /不存在/);
});

await test('readDataUrl：缩略图优先、回落原图、缺失报错、坏名拒绝', () => {
  const dir = freshDir();
  const src = path.join(sandbox, 'src3');
  fs.mkdirSync(src, { recursive: true });
  const f = path.join(src, 'x.png');
  fs.writeFileSync(f, PNG_1PX);
  const { added } = addPhotos(dir, 'p_me', [f], nativeImageStub);
  const name = added[0];

  const t = readDataUrl(dir, name, true);
  assert.equal(t.ok, true);
  assert.equal(t.thumb, true);
  assert.ok(t.dataUrl.startsWith('data:image/png;base64,'));

  const o = readDataUrl(dir, name, false);
  assert.equal(o.ok, true);
  assert.equal(o.thumb, false);

  const miss = readDataUrl(dir, 'pme-000000.jpg', false);
  assert.equal(miss.ok, false);
  assert.match(miss.error, /不存在/);

  for (const evil of ['../x.png', 'a/b.png', 'C:\\x.png', '']) {
    const r = readDataUrl(dir, evil, false);
    assert.equal(r.ok, false, `应拒绝 ${JSON.stringify(evil)}`);
  }
});

await test('readMany：存在的进 map，缺失的进 missing', () => {
  const dir = freshDir();
  const src = path.join(sandbox, 'src4');
  fs.mkdirSync(src, { recursive: true });
  const f = path.join(src, 'x.png');
  fs.writeFileSync(f, PNG_1PX);
  const { added } = addPhotos(dir, 'p_me', [f], nativeImageStub);
  const r = readMany(dir, [added[0], 'pme-ffffff.jpg', '../evil.png']);
  assert.deepEqual(Object.keys(r.map), [added[0]]);
  assert.equal(r.missing.length, 2);
  assert.equal(r.missing.includes('../evil.png'), true);
});

await test('removePhotos：连缩略图一起删；ENOENT 视为已删；坏名进 errors', () => {
  const dir = freshDir();
  const src = path.join(sandbox, 'src5');
  fs.mkdirSync(src, { recursive: true });
  const f = path.join(src, 'x.png');
  fs.writeFileSync(f, PNG_1PX);
  const { added } = addPhotos(dir, 'p_me', [f], nativeImageStub);
  const name = added[0];
  const thumb = path.join(dir, name.replace(/\.png$/, '.thumb.png'));

  const r1 = removePhotos(dir, [name]);
  assert.deepEqual(r1.removed, [name]);
  assert.equal(r1.errors.length, 0);
  assert.equal(fs.existsSync(path.join(dir, name)), false);
  assert.equal(fs.existsSync(thumb), false, '缩略图一并删除');

  // 再删一次（文件已不在）→ 仍算 removed（ENOENT 视为已删）
  const r2 = removePhotos(dir, [name]);
  assert.deepEqual(r2.removed, [name]);

  // 目录外路径 → 拒绝，且不误删
  const outside = path.join(sandbox, 'precious.txt');
  fs.writeFileSync(outside, 'precious');
  const r3 = removePhotos(dir, ['../precious.txt', 'a/b.png']);
  assert.equal(r3.removed.length, 0);
  assert.equal(r3.errors.length, 2);
  assert.equal(fs.existsSync(outside), true, '目录外文件毫发无损');
});

await test('restoreMap：dataUrl 落盘、已存在跳过、坏名/坏数据进 errors', () => {
  const dir = freshDir();
  const url = 'data:image/png;base64,AAAA';
  const r = restoreMap(dir, {
    'p_me-aaa111.png': url,
    'p_me-bbb222.png': url,
    '../escape.png': url,
    'a/b.png': url,
    'p_me-ccc333.png': 'not-a-data-url',
  });
  assert.deepEqual(r.written.sort(), ['p_me-aaa111.png', 'p_me-bbb222.png']);
  assert.equal(r.skipped.length, 0);
  assert.equal(r.errors.length, 3);
  // AAAA base64 = 3 个 0 字节
  assert.equal(fs.readFileSync(path.join(dir, 'p_me-aaa111.png')).length, 3);
  assert.equal(fs.existsSync(path.join(sandbox, 'escape.png')), false, '没有越界写出');

  // 再来一遍 → 全部跳过（不覆盖）
  const r2 = restoreMap(dir, { 'p_me-aaa111.png': 'data:image/png;base64,BBBB' });
  assert.deepEqual(r2.skipped, ['p_me-aaa111.png']);
  assert.equal(r2.written.length, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'p_me-aaa111.png')).toString('base64'), 'AAAA');
});

await test('扩展名白名单与 PHOTO_EXTS 一致', () => {
  assert.deepEqual(PHOTO_EXTS.slice().sort(), ['bmp', 'gif', 'jpeg', 'jpg', 'png', 'webp']);
});

/* ========================================================= */
/* 汇总                                                        */
/* ========================================================= */

console.log(`\n${'='.repeat(46)}`);
if (failures.length) {
  console.log(`\x1b[31m${failures.length} 个失败\x1b[0m（共 ${passed + failures.length} 例）`);
  for (const f of failures) console.log(`  · [${f.group}] ${f.name}: ${f.message}`);
  process.exit(1);
} else {
  console.log(`\x1b[32m全部通过\x1b[0m（${passed} 例）`);
}
