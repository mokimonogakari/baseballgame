/**
 * 実況（テキスト）。状況別のテンプレートからオリジナルの実況文を組み立てる。
 * 文はすべて本作オリジナル（実在の実況者の決まり文句は使わない）。
 *
 * export function createCommentary(rng = Math.random)
 *   → { atBatStart(c), prePitch(c), contact(c), result(c), reset() }
 *   c（状況）: {
 *     name, order, pos, stats: { ab, h, hr, rbi, so, bb }, pa（今日何打席目か 1..）,
 *     balls, strikes, outs, bases: [bool,bool,bool], inning, half, innings, lead（攻撃側から見た点差）,
 *     pitcherName, pitcherK（投手の今日の奪三振）, firstPitch（打席の 1 球目か）, userBatting,
 *     event（pitchContact / resolveBattedBall の event）, ball（打球）, prevLead（打つ前の点差）, over（試合終了か）
 *   }
 * 各関数は文字列か null（言うことが無い）を返す。直近の文・テンプレートは避ける。
 */

const RECENT_LINES = 8;
const RECENT_IDS = 10;

const dirName = (deg) => {
  const d = Number(deg);
  if (!Number.isFinite(d)) return '';
  if (d < -30) return 'レフト線';
  if (d < -12) return 'レフト';
  if (d < -5) return '左中間';
  if (d <= 5) return 'センター';
  if (d <= 12) return '右中間';
  if (d <= 30) return 'ライト';
  return 'ライト線';
};
const infieldName = (deg) => {
  const d = Number(deg);
  if (!Number.isFinite(d)) return '';
  if (d < -25) return 'サード';
  if (d < -8) return '三遊間';
  if (d < 0) return 'ショート';
  if (d <= 8) return 'セカンド';
  if (d <= 25) return '一二塁間';
  return 'ファースト';
};
const KANJI_OUTS = ['ノーアウト', 'ワンアウト', 'ツーアウト'];

function basesLabel(b) {
  const [f, s, t] = (b || []).map(Boolean);
  if (f && s && t) return '満塁';
  if (s && t) return '二、三塁';
  if (f && t) return '一、三塁';
  if (f && s) return '一、二塁';
  if (t) return '三塁';
  if (s) return '二塁';
  if (f) return '一塁';
  return '';
}
const risp = (b) => !!(b && (b[1] || b[2]));
const runnersOn = (b) => (b || []).filter(Boolean).length;

export function createCommentary(rng = Math.random) {
  const recentLines = [];
  const recentIds = [];

  /** 候補 [{ id, w?, text }] から直近を避けて 1 つ選ぶ */
  function pick(cands) {
    const list = cands.filter((c) => c && c.text);
    if (!list.length) return null;
    let pool = list.filter((c) => !recentIds.includes(c.id) && !recentLines.includes(c.text));
    if (!pool.length) pool = list.filter((c) => !recentLines.includes(c.text));
    if (!pool.length) pool = list;
    const total = pool.reduce((s, c) => s + (c.w ?? 1), 0);
    let r = rng() * total;
    let chosen = pool[pool.length - 1];
    for (const c of pool) { r -= c.w ?? 1; if (r <= 0) { chosen = c; break; } }
    remember(chosen);
    return chosen.text;
  }
  function remember(c) {
    recentIds.push(c.id);
    recentLines.push(c.text);
    while (recentIds.length > RECENT_IDS) recentIds.shift();
    while (recentLines.length > RECENT_LINES) recentLines.shift();
  }
  /** 部品を 1 つ選ぶ（記録しない） */
  const one = (arr) => arr[Math.floor(rng() * arr.length) % arr.length];

  // ---------- ① 打席登場 ----------
  function atBatStart(c = {}) {
    const name = c.name || 'バッター';
    const order = c.order ? `${c.order}番` : '';
    const pos = c.pos || '';
    const st = c.stats || {};
    const ab = st.ab ?? 0, h = st.h ?? 0, hr = st.hr ?? 0, rbi = st.rbi ?? 0;
    const pa = c.pa ?? 1;
    const intro = [
      { id: 'in1', text: `${order}${pos ? ` ${pos}` : ''}、${name}が打席へ。` },
      { id: 'in2', text: `打席には${order}の${name}。` },
      { id: 'in3', text: `続くバッターは${name}${pos ? `（${pos}）` : ''}。` },
      { id: 'in4', text: `さあ${order}、${name}の登場です。` },
      { id: 'in5', text: `${name}、バットを短く持って構えます。` },
      { id: 'in6', text: `ここで${order ? `${order}、` : ''}${name}。` },
    ];
    let stat;
    if (pa <= 1) stat = one(['今日はこれが最初の打席。', 'まずは第1打席、どう入るか。', '第1打席、相手投手との初対決です。']);
    else if (hr >= 1) stat = one([`今日すでに${hr}本のホームラン！`, `今日は${ab}打数${h}安打${hr}本塁打、警戒が必要です。`]);
    else if (h >= 2) stat = one([`ここまで${ab}打数${h}安打、当たっています！`, `今日は${h}安打と好調です。`]);
    else if (h === 1) stat = one([`ここまで${ab}打数1安打。`, `今日はヒット1本、${rbi ? `${rbi}打点。` : 'もう1本ほしい。'}`]);
    else if (ab >= 2) stat = one([`ここまで${ab}打数ノーヒット、そろそろ快音を。`, `今日はまだヒットがありません。`]);
    else if (ab === 1) stat = '前の打席は凡退でした。';
    else stat = `第${pa}打席です。`;
    const sit = situation(c, true);
    const base = pick(intro);
    return [base, stat, sit].filter(Boolean).join(' ');
  }

  /** 状況の一言（得点圏・終盤・満塁など）。intro=true は打席登場用 */
  function situation(c, intro) {
    const b = c.bases || [];
    const outs = c.outs ?? 0;
    const lead = c.lead ?? 0;
    const late = (c.inning ?? 1) >= Math.max(1, (c.innings ?? 9) - 1);
    const lbl = basesLabel(b);
    const out = [];
    if (b[0] && b[1] && b[2]) {
      if (outs === 2 && lead < 0 && lead >= -3) out.push({ id: 's-bl-gyaku', w: 3, text: 'ツーアウト満塁、一打逆転のチャンス！' });
      else if (lead < 0 && lead >= -3) out.push({ id: 's-bl-gyaku2', w: 3, text: `${KANJI_OUTS[outs] || ''}満塁、長打が出れば逆転！` });
      else if (lead === 0) out.push({ id: 's-bl-kachi', w: 3, text: `${KANJI_OUTS[outs] || ''}満塁、勝ち越しの大チャンス！` });
      else out.push({ id: 's-bl', w: 2, text: `${KANJI_OUTS[outs] || ''}満塁！ 球場が沸いています。` });
    } else if (risp(b)) {
      if (lead === -1) out.push({ id: 's-risp-tie', w: 2, text: `${KANJI_OUTS[outs] || ''}${lbl}、同点のランナーが得点圏に！` });
      else if (lead === 0) out.push({ id: 's-risp-go', w: 2, text: `${KANJI_OUTS[outs] || ''}${lbl}、一本出れば勝ち越し！` });
      else out.push({ id: 's-risp', text: `${KANJI_OUTS[outs] || ''}${lbl}、得点圏にランナー。` });
      if (outs === 2) out.push({ id: 's-risp2', text: 'ツーアウトから、ここは粘りたい。' });
    } else if (intro && outs === 0 && !runnersOn(b)) {
      out.push({ id: 's-lead', w: 0.6, text: 'まずは先頭として塁に出たい。' });
    }
    if (late && Math.abs(lead) <= 1 && !intro) out.push({ id: 's-late', text: lead === 0 ? '終盤、同点の緊迫した展開。' : '終盤、1点を争う展開です。' });
    if (!out.length) return '';
    if (!intro && rng() < 0.25) return '';
    return pick(out) || '';
  }

  // ---------- ② 投球前 ----------
  function prePitch(c = {}) {
    if (c.firstPitch) return null;
    const b = c.balls ?? 0, s = c.strikes ?? 0;
    const p = c.pitcherName || 'ピッチャー';
    const cands = [];
    if (b === 3 && s === 2) cands.push({ id: 'p-full', w: 3, text: one(['フルカウント！ 次の一球で決まるか。', 'カウント3-2、勝負の一球。']) });
    else if (s === 2 && b === 0) cands.push({ id: 'p-02', w: 2, text: one(['追い込まれました、ここは粘りたい。', 'ツーストライク、ボール球に注意。']) });
    else if (b === 3 && s === 0) cands.push({ id: 'p-30', w: 2, text: 'ボールが3つ先行、ストライクがほしい投手。' });
    else if (b >= 2 && b > s) cands.push({ id: 'p-bk', text: `ボール先行、${p}は苦しいカウント。` });
    else if (s === 2) cands.push({ id: 'p-2s', text: 'ツーストライクと追い込んだ。' });
    const sit = situation(c, false);
    if (sit) cands.push({ id: `p-sit-${sit.length}`, w: 2, text: sit });
    cands.push({ id: 'p-set', w: 0.6, text: runnersOn(c.bases) ? `${p}、セットポジションから…` : `${p}、振りかぶって…` });
    cands.push({ id: 'p-look', w: 0.4, text: `${p}、サインにうなずいて…` });
    if (rng() < 0.3) return null;
    return pick(cands);
  }

  // ---------- ③ 打球直後 ----------
  function contact(c = {}) {
    const ev = c.event || {};
    const ball = c.ball || ev.ball || {};
    const tier = ev.contactTier;
    const type = ball.type || 'fly';
    const dist = Number(ball.distance) || 0;
    const dir = dirName(ball.dirDeg);
    const inf = infieldName(ball.dirDeg);
    const lead = tier === 'shin2' ? one(['完璧にとらえた！ ', '芯で叩いた！ ', '会心の当たり！ ']) : tier === 'shin' ? one(['いい当たり！ ', 'しっかり振り抜いた！ ', '']) : '';
    const cands = [];
    if (ev.bunt || ev.mode === 'bunt') {
      cands.push({ id: 'c-bunt', text: 'バットに当てて転がした！' }, { id: 'c-bunt2', text: '勢いを殺したバント！' });
    } else if (ev.kind === 'foul' || ball.isFoul) {
      cands.push({ id: 'c-foul', text: '切れてファウル。' }, { id: 'c-foul2', text: 'これは後ろへ、ファウルボール。' }, { id: 'c-foul3', text: 'バックネットへのファウル。' });
    } else if (ball.isHomeRun || type === 'hr' || (type === 'fly' && dist >= 100)) {
      cands.push({ id: 'c-big', text: `${lead}打球は${dir || '外野'}へ、大きい！` }, { id: 'c-big2', text: `${lead}高々と上がった！ 伸びる、伸びる！` }, { id: 'c-big3', text: `${lead}${dir || '外野'}の奥へぐんぐん伸びていく！` });
    } else if (type === 'liner') {
      cands.push({ id: 'c-lin', text: `${lead}鋭いライナー、${dir || '外野'}へ！` }, { id: 'c-lin2', text: `${lead}低く速い打球が${dir || '外野'}へ！` });
    } else if (type === 'grounder') {
      const side = inf === '三遊間' || inf === '一二塁間' ? inf : '';
      cands.push({ id: 'c-gr', text: `${lead}${side ? `${side}へ` : ''}ゴロが転がる！` }, { id: 'c-gr2', text: `${lead}叩きつけた、内野へのゴロ！` }, { id: 'c-gr3', text: `${lead}低い当たり、内野が追う！` });
    } else if (type === 'popup') {
      if (tier === 'shin' || tier === 'shin2') cands.push({ id: 'c-popg', text: '高々と上がった！ 伸びるか…' });
      else cands.push({ id: 'c-pop', text: 'ああっと、真上に打ち上げてしまった…' }, { id: 'c-pop2', text: '詰まらされた、高いフライ…' });
    } else {
      cands.push({ id: 'c-fly', text: `${lead}${dir || '外野'}へのフライ！` }, { id: 'c-fly2', text: `${lead}打ち上げた、${dir || '外野'}へ！` });
    }
    return pick(cands);
  }

  // ---------- ④ 結果のあと ----------
  function result(c = {}) {
    const ev = c.event || {};
    const kind = ev.kind;
    const runs = ev.runs || 0;
    const st = c.stats || {};
    const prevLead = c.prevLead ?? 0;
    const lead = c.lead ?? prevLead;
    const name = c.name || '';
    const cands = [];
    const mistake = !!ev.pitch?.mistake && (kind === 'hit' || kind === 'hr');
    const pre = mistake ? '甘い球！ 見逃さなかった！ ' : '';
    const turned = prevLead <= 0 && lead > 0 ? (prevLead < 0 ? '逆転！ ' : '勝ち越し！ ') : prevLead < 0 && lead === 0 ? '同点！ ' : '';
    const walkoff = c.over && turned && c.half === 'bottom';
    if (walkoff) cands.push({ id: 'r-walkoff', w: 10, text: `${pre}サヨナラ！ ${name}が試合を決めた！` });
    else if (kind === 'hr') {
      const label = runs >= 4 ? '満塁ホームラン！' : runs === 3 ? 'スリーランホームラン！' : runs === 2 ? 'ツーランホームラン！' : 'ソロホームラン！';
      cands.push({ id: 'r-hr', text: `${pre}${turned}${label} ${name}、${st.hr > 1 ? `今日${st.hr}本目！` : 'ゆっくりとダイヤモンドを回ります。'}` });
      cands.push({ id: 'r-hr2', text: `${pre}${turned}${label} スタンドが揺れています！` });
    } else if (kind === 'hit') {
      if (runs > 0) {
        cands.push({ id: 'r-tl', text: `${pre}${turned}タイムリー！ ${runs}点が入ります！` });
        cands.push({ id: 'r-tl2', text: `${pre}${turned}ランナーが還る！ ${name}、これで${st.rbi ?? runs}打点目。` });
      } else if ((st.h ?? 0) >= 3) cands.push({ id: 'r-moda', w: 3, text: `${pre}猛打賞！ 今日${st.h}本目のヒット！` });
      else if ((st.h ?? 0) === 2) cands.push({ id: 'r-2h', w: 2, text: `${pre}今日2本目のヒット！ 好調です。` });
      cands.push({ id: 'r-hit', text: `${pre}${turned}きれいにはじき返しました。` });
      cands.push({ id: 'r-hit2', text: `${pre}${turned}${name}、うまく運んだ！` });
    } else if (kind === 'strikeout') {
      const k = c.pitcherK ?? 0;
      if (k >= 3) cands.push({ id: 'r-kk', w: 2, text: `${c.pitcherName || '投手'}、これで今日${k}個目の三振！` });
      if (ev.swing) cands.push({ id: 'r-ksw', text: 'タイミングが合いませんでした。' }, { id: 'r-ksw2', text: '最後は振らされました、投手の勝ち。' }, { id: 'r-ksw3', text: '次の打席で取り返したい。' });
      else cands.push({ id: 'r-klk', text: '際どいコース、手が出ませんでした。' }, { id: 'r-klk2', text: '狙い球が違ったか、バットが出ず。' });
    } else if (kind === 'walk') {
      cands.push({ id: 'r-bb', text: 'じっくり見極めました。' }, { id: 'r-bb2', text: 'ボール球に手を出さなかった。' });
      if (runs > 0) cands.push({ id: 'r-bbr', w: 3, text: '押し出し！ 労せず1点が入ります。' });
    } else if (kind === 'hbp') {
      cands.push({ id: 'r-hbp', text: '当たってしまった、デッドボール。' }, { id: 'r-hbp2', text: '体に当たって一塁へ。大丈夫でしょうか。' });
    } else if (kind === 'ibb') {
      cands.push({ id: 'r-ibb', text: 'ここは勝負を避けて敬遠。' }, { id: 'r-ibb2', text: 'ベンチの指示で歩かせます。' });
    } else if (kind === 'double_play') {
      cands.push({ id: 'r-dp', text: 'ダブルプレー！ 一瞬で2つのアウト。' }, { id: 'r-dp2', text: 'ゲッツー、ピンチをしのぎました。' });
    } else if (kind === 'sac_fly') {
      cands.push({ id: 'r-sf', text: `犠牲フライ！ きっちり${runs || 1}点。` });
    } else if (kind === 'sac_bunt') {
      cands.push({ id: 'r-sb', text: '送りバント成功、ランナーを進めました。' });
    } else if (kind === 'error') {
      cands.push({ id: 'r-err', text: 'ああっと、エラー！ 生きました。' });
    } else if (kind === 'out' || kind === 'fielders_choice') {
      if (runs > 0) cands.push({ id: 'r-outr', w: 2, text: `アウトの間に${runs}点！` });
      cands.push({ id: 'r-out', text: '打ち取られました。' }, { id: 'r-out3', text: 'ここは守備が上回りました。' });
      if (ev.contactTier === 'shin' || ev.contactTier === 'shin2') cands.push({ id: 'r-out2', w: 2, text: 'いい当たりでしたが野手の正面。' });
      else cands.push({ id: 'r-out4', text: 'うまく打たされました。' });
    } else return null;
    let line = pick(cands);
    if (line && ev.wildPitch) line += ' 暴投！ランナー進塁';
    return line;
  }

  function reset() { recentLines.length = 0; recentIds.length = 0; }

  return { atBatStart, prePitch, contact, result, reset };
}
