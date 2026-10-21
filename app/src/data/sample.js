/**
 * =========================================================
 * 示例数据 · sample.js
 * ---------------------------------------------------------
 * 用途：首次启动 / 演示。真实使用时由用户录入或导入 CSV 覆盖。
 *
 * ⚠️ 与上一版（UI 设计稿里的假数据）的差别 —— 修正了一处结构性矛盾：
 *   旧数据里「二爷爷（林建军）」是爷爷的弟弟（第 2 代），
 *   却把「林浩」写成他的儿子且标为第 0 代（堂弟）。
 *   父子差两代，世次矛盾 —— F8.3 会报错。
 *   正确结构应是：二爷爷的儿子是「堂叔」（第 1 代），
 *                 堂弟的父亲是爸爸的兄弟（三叔）。
 *   本文件按正确结构重建，并把「堂叔」和「堂弟」两个角色分开。
 *
 * 世次（gen）：3 曾祖辈 / 2 祖辈 / 1 父母辈 / 0 我辈 / -1 子侄辈
 */

export const SAMPLE_DATA = {
  version: '1.0',
  viewpoint: 'p_me',

  people: [
    /* ---------- 父系 · 曾祖辈 ---------- */
    { id: 'p_g1',  name: '林广德', sex: 'M', birth: '1912', death: '1978', gen: 3, order: 0, privacy: 'public',
      place: '河南南阳', note: '务农，民国年间迁居南阳' },
    { id: 'p_g1w', name: '陈氏',   sex: 'F', birth: '1915', death: '1985', gen: 3, order: 0, privacy: 'public',
      place: '河南南阳' },

    /* ---------- 父系 · 祖辈 ---------- */
    { id: 'p_p2',  name: '林建国', sex: 'M', birth: '1936', death: '2015', gen: 2, order: 0, privacy: 'public',
      place: '南阳', note: '退休职工' },
    { id: 'p_p2w', name: '王秀英', sex: 'F', birth: '1940', gen: 2, order: 0, privacy: 'public', place: '南阳' },
    { id: 'p_p2s', name: '林建军', sex: 'M', birth: '1943', gen: 2, order: 1, privacy: 'family',
      place: '南阳', note: '二爷爷' },
    { id: 'p_p2sw',name: '张桂芳', sex: 'F', birth: '1946', gen: 2, order: 1, privacy: 'family', place: '南阳' },

    /* ---------- 父系 · 父母辈 ---------- */
    { id: 'p_gu',  name: '林志芳', sex: 'F', birth: '1960', gen: 1, order: 0, privacy: 'family',
      place: '南阳', note: '大姑' },
    { id: 'p_guf', name: '周建华', sex: 'M', birth: '1958', gen: 1, order: 0, privacy: 'family', place: '南阳' },
    { id: 'p_f',   name: '林志远', sex: 'M', birth: '1963', gen: 1, order: 1, privacy: 'family',
      place: '南阳', note: '中学教师' },
    { id: 'p_m',   name: '李慧兰', sex: 'F', birth: '1965', gen: 1, order: 1, privacy: 'family', place: '南阳' },
    { id: 'p_unc', name: '林志强', sex: 'M', birth: '1968', gen: 1, order: 2, privacy: 'family',
      place: '南阳', note: '三叔' },
    { id: 'p_aunt',name: '刘敏',   sex: 'F', birth: '1970', gen: 1, order: 2, privacy: 'family', place: '南阳' },
    { id: 'p_p2ss',name: '林志刚', sex: 'M', birth: '1971', gen: 1, order: 0, privacy: 'family',
      place: '南阳', note: '二爷爷的儿子 —— 爸爸的堂弟' },

    /* ---------- 父系 · 我辈 ---------- */
    { id: 'p_bro', name: '林涛',   sex: 'M', birth: '1988', gen: 0, order: 0, privacy: 'family',
      place: '南阳', note: '哥哥' },
    { id: 'p_sis', name: '孙雯',   sex: 'F', birth: '1990', gen: 0, order: 0, privacy: 'family', place: '南阳' },
    { id: 'p_me',  name: '林然',   sex: 'M', birth: '1992', gen: 0, order: 1, privacy: 'family',
      place: '南阳', note: '本人' },
    { id: 'p_wife',name: '王雨桐', sex: 'F', birth: '1993', gen: 0, order: 1, privacy: 'family', place: '南阳' },
    { id: 'p_cous',name: '林浩',   sex: 'M', birth: '1995', gen: 0, order: 0, privacy: 'family',
      place: '南阳', note: '三叔的儿子' },

    /* ---------- 父系 · 子侄辈 ---------- */
    { id: 'p_nep', name: '林小宇', sex: 'M', birth: '2016', gen: -1, order: 0, privacy: 'private',
      place: '南阳', note: '未成年人' },
    { id: 'p_son', name: '林小满', sex: 'M', birth: '2020', gen: -1, order: 1, privacy: 'private',
      place: '南阳', note: '未成年人' },

    /* ---------- 母系 · 外公家 ---------- */
    { id: 'p_mg',  name: '李长顺', sex: 'M', birth: '1938', death: '2012', gen: 2, order: 0, privacy: 'public',
      place: '河南南阳' },
    { id: 'p_mgw', name: '刘桂香', sex: 'F', birth: '1942', gen: 2, order: 0, privacy: 'public', place: '河南南阳' },
    { id: 'p_mun', name: '李建军', sex: 'M', birth: '1962', gen: 1, order: 0, privacy: 'family',
      place: '南阳', note: '舅舅' },
    { id: 'p_munw',name: '赵红',   sex: 'F', birth: '1964', gen: 1, order: 0, privacy: 'family', place: '南阳' },
    { id: 'p_myi', name: '李慧芳', sex: 'F', birth: '1970', gen: 1, order: 2, privacy: 'family',
      place: '南阳', note: '姨妈' },
    { id: 'p_myif',name: '孙国平', sex: 'M', birth: '1968', gen: 1, order: 2, privacy: 'family', place: '南阳' },
    { id: 'p_mbro',name: '李伟',   sex: 'M', birth: '1988', gen: 0, order: 1, privacy: 'family',
      place: '南阳', note: '舅舅的儿子' },
    { id: 'p_msis',name: '孙婷',   sex: 'F', birth: '1995', gen: 0, order: 2, privacy: 'family',
      place: '南阳', note: '姨妈的女儿' },

    /* ---------- 妻系 · 岳父家 ---------- */
    { id: 'p_wg',  name: '王德海', sex: 'M', birth: '1918', death: '2001', gen: 2, order: 0, privacy: 'public',
      place: '河南南阳' },
    { id: 'p_wgw', name: '周氏',   sex: 'F', birth: '1921', death: '1999', gen: 2, order: 0, privacy: 'public',
      place: '河南南阳' },
    { id: 'p_wf',  name: '王国栋', sex: 'M', birth: '1966', gen: 1, order: 0, privacy: 'family',
      place: '南阳', note: '退休工人' },
    { id: 'p_wm',  name: '陈玉华', sex: 'F', birth: '1968', gen: 1, order: 0, privacy: 'family', place: '南阳' },
    { id: 'p_wu',  name: '王志远', sex: 'M', birth: '1987', gen: 0, order: 0, privacy: 'family',
      place: '南阳', note: '妻子的哥哥' },
    { id: 'p_wus', name: '胡娟',   sex: 'F', birth: '1989', gen: 0, order: 0, privacy: 'family', place: '南阳' },
    { id: 'p_wsis',name: '王雨欣', sex: 'F', birth: '1996', gen: 0, order: 2, privacy: 'family',
      place: '南阳', note: '妻子的妹妹' },
    { id: 'p_wnep',name: '王志豪', sex: 'M', birth: '2012', gen: -1, order: 0, privacy: 'private',
      place: '南阳', note: '内兄的儿子，未成年人' },
  ],

  /* type='parent' → a 是 b 的父亲或母亲（性别查 people.sex）
     type='spouse' → a 与 b 是夫妻（无向，只写一条） */
  relationships: [
    /* --- 亲子 · 父系（父母两侧都要写，缺一侧会导致「母亲」推导不出来） --- */
    { a: 'p_g1',   b: 'p_p2',  type: 'parent', confidence: 'high' },
    { a: 'p_g1',   b: 'p_p2s', type: 'parent', confidence: 'high',
      note: '二爷爷与爷爷同为曾祖父之子 —— 漏这条会让二爷爷变成孤儿' },
    { a: 'p_g1w',  b: 'p_p2',  type: 'parent', confidence: 'high' },
    { a: 'p_g1w',  b: 'p_p2s', type: 'parent', confidence: 'high' },

    { a: 'p_p2',   b: 'p_gu',  type: 'parent', confidence: 'high' },
    { a: 'p_p2',   b: 'p_f',   type: 'parent', confidence: 'high' },
    { a: 'p_p2',   b: 'p_unc', type: 'parent', confidence: 'high' },
    { a: 'p_p2w',  b: 'p_gu',  type: 'parent', confidence: 'high' },
    { a: 'p_p2w',  b: 'p_f',   type: 'parent', confidence: 'high' },
    { a: 'p_p2w',  b: 'p_unc', type: 'parent', confidence: 'high' },

    { a: 'p_p2s',  b: 'p_p2ss',type: 'parent', confidence: 'high' },
    { a: 'p_p2sw', b: 'p_p2ss',type: 'parent', confidence: 'high' },

    { a: 'p_f',    b: 'p_bro', type: 'parent', confidence: 'high' },
    { a: 'p_f',    b: 'p_me',  type: 'parent', confidence: 'high' },
    { a: 'p_m',    b: 'p_bro', type: 'parent', confidence: 'high' },
    { a: 'p_m',    b: 'p_me',  type: 'parent', confidence: 'high' },

    { a: 'p_unc',  b: 'p_cous',type: 'parent', confidence: 'high' },
    { a: 'p_aunt', b: 'p_cous',type: 'parent', confidence: 'high' },

    { a: 'p_bro',  b: 'p_nep', type: 'parent', confidence: 'high' },
    { a: 'p_sis',  b: 'p_nep', type: 'parent', confidence: 'high' },

    { a: 'p_me',   b: 'p_son', type: 'parent', confidence: 'high' },
    { a: 'p_wife', b: 'p_son', type: 'parent', confidence: 'high' },

    /* --- 亲子 · 母系（外公家） --- */
    { a: 'p_mg',   b: 'p_m',   type: 'parent', confidence: 'high' },
    { a: 'p_mg',   b: 'p_mun', type: 'parent', confidence: 'high' },
    { a: 'p_mg',   b: 'p_myi', type: 'parent', confidence: 'high' },
    { a: 'p_mgw',  b: 'p_m',   type: 'parent', confidence: 'high' },
    { a: 'p_mgw',  b: 'p_mun', type: 'parent', confidence: 'high' },
    { a: 'p_mgw',  b: 'p_myi', type: 'parent', confidence: 'high' },

    { a: 'p_mun',  b: 'p_mbro',type: 'parent', confidence: 'high' },
    { a: 'p_munw', b: 'p_mbro',type: 'parent', confidence: 'high' },

    { a: 'p_myi',  b: 'p_msis',type: 'parent', confidence: 'high' },
    { a: 'p_myif', b: 'p_msis',type: 'parent', confidence: 'high' },

    /* --- 亲子 · 妻系（岳父家） --- */
    { a: 'p_wg',   b: 'p_wf',  type: 'parent', confidence: 'high' },
    { a: 'p_wgw',  b: 'p_wf',  type: 'parent', confidence: 'high' },

    { a: 'p_wf',   b: 'p_wu',  type: 'parent', confidence: 'high' },
    { a: 'p_wf',   b: 'p_wife',type: 'parent', confidence: 'high' },
    { a: 'p_wf',   b: 'p_wsis',type: 'parent', confidence: 'high' },
    { a: 'p_wm',   b: 'p_wu',  type: 'parent', confidence: 'high' },
    { a: 'p_wm',   b: 'p_wife',type: 'parent', confidence: 'high' },
    { a: 'p_wm',   b: 'p_wsis',type: 'parent', confidence: 'high' },

    { a: 'p_wu',   b: 'p_wnep',type: 'parent', confidence: 'high' },
    { a: 'p_wus',  b: 'p_wnep',type: 'parent', confidence: 'high' },

    /* --- 婚配 --- */
    { a: 'p_g1',  b: 'p_g1w', type: 'spouse', confidence: 'high' },
    { a: 'p_p2',  b: 'p_p2w', type: 'spouse', confidence: 'high' },
    { a: 'p_p2s', b: 'p_p2sw',type: 'spouse', confidence: 'high' },
    { a: 'p_gu',  b: 'p_guf', type: 'spouse', confidence: 'high' },
    { a: 'p_f',   b: 'p_m',   type: 'spouse', from: '1986', confidence: 'high' },
    { a: 'p_unc', b: 'p_aunt',type: 'spouse', confidence: 'high' },
    { a: 'p_bro', b: 'p_sis', type: 'spouse', confidence: 'high' },
    { a: 'p_me',  b: 'p_wife',type: 'spouse', from: '2018', confidence: 'high' },
    { a: 'p_mg',  b: 'p_mgw', type: 'spouse', confidence: 'high' },
    { a: 'p_mun', b: 'p_munw',type: 'spouse', confidence: 'high' },
    { a: 'p_myi', b: 'p_myif',type: 'spouse', confidence: 'high' },
    { a: 'p_wg',  b: 'p_wgw', type: 'spouse', confidence: 'high' },
    { a: 'p_wf',  b: 'p_wm',  type: 'spouse', confidence: 'high' },
    { a: 'p_wu',  b: 'p_wus', type: 'spouse', confidence: 'high' },
  ],
};