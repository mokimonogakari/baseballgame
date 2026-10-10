/**
 * チーム・選手データ（ドキドキベースボール）
 * 純粋なデータ定義。DOM・エンジンには依存しない。
 *
 * ■ オマージュ選手（docs/ROSTER-HOMAGE.md に一覧）
 *   全76人が、それぞれ特定の実在のプロ野球選手（NPB/MLB の現役スター・OB）をモチーフにしている。
 *   ただし選手名はすべて架空（肖像権・氏名権・パブリシティ権への配慮）。実名・愛称・本人を
 *   特定できる背番号・名前のもじりは使わない。`model` には「どんな経歴・成績の選手タイプか」を
 *   実名なしで記す。成績は概数（公開記録の目安）であり、厳密な公式記録ではない。
 *
 * ■ チームのテーマ（総合戦力はほぼ同等。CPU 同士 各カード 400 試合でどのカードも勝率 4〜6 割）
 *   red    レッドスターズ        … 現役NPBスター軍（2020年代のタイトルホルダー）
 *   blue   ブルーウェーブス      … MLB軍（MLBで活躍した日本人＋MLBのスター）
 *   green  グリーンファイターズ  … 昭和のレジェンドOB軍
 *   yellow イエローサンダース    … 平成のOB・名手軍
 *
 * ■ 成績 → 能力値（1-99）の換算の目安（本人のキャリアの全盛期を 143 試合換算で評価）
 *   打率・安打   → contact  = 40 + (打率 - .220) × 400  （.280→64 / .300→72 / .320→80）
 *   本塁打・長打率→ power    = 40 + 本塁打 × 1.3          （20本→66 / 30本→79 / 40本→92）
 *                 trajectory 1-4 = 弾道（ゴロ打ち 1 / 中距離 2 / 長距離 3 / アーチスト 4）
 *   盗塁・走塁   → speed    = 40 + 盗塁 × 1.2（走塁評価・一塁到達タイムで ±10）
 *   肩・補殺     → arm      = 送球の強さ（補殺・盗塁阻止率・投手なら球速の目安）
 *   守備指標・GG → fielding = 守備範囲（UZR・ゴールデングラブ受賞歴）、catching = 捕球の確実さ（守備率）
 *   球速         → velocity = 全盛期の平均〜最速の中間 km/h（昭和の投手は証言からの推定）
 *   与四球率     → control  = 99 - (BB/9 - 1.0) × 20 を目安に 50〜90 へ圧縮
 *   投球回・完投 → stamina  = 10 + 投球回 × 0.40（先発 75〜95 / 中継ぎ 30〜55）
 *   決め球       → pitches  = 球種と変化量 level 0〜7（伝説級の決め球 6〜7、一級品 5、持ち球 2〜4）
 *   投手の打撃能力は contact/power 10〜25 前後（投手の打撃成績から）。
 * ■ スケール（パワプロ準拠）: 普通のレギュラー C〜B（60〜79）、スター A（80〜89）、
 *   S（90+）は歴代屈指の選手の代名詞の能力だけ。金特（天才打者・怪力・怪物球威）は歴代屈指の選手のみ、
 *   赤特は実際の弱点（三振の多い長距離砲 → 三振、制球難 → 四球 など）。
 *   時代補正: 昭和の投高打低・打高投低は均し、チームコスト（playerCost の合計）が 160〜167 にそろうよう
 *   代名詞以外の能力を控えめにしている。skills は SKILLS の名前のみ（1〜4個）。
 */


/**
 * 球種定義（BALANCE.md）。dx/dy はゾーンセル単位（打者カメラの画面で +x=右, +y=下）、read=見切り難度。
 * dx/dy は変化量 level 3 のときの変化（エンジンは level で拡大縮小: ×(0.7 + 0.1×level)、engine.pitchBreak 参照）。
 * 右投手基準、左投手は dx 反転。fastballFamily=ストレート系（スタミナ消費が少ない）。
 */
export const PITCH_TYPES = {
  fastball: { name: 'ストレート', dx: 0, dy: 0, read: 0.15, fastballFamily: true },
  twoseam: { name: 'ツーシーム', dx: -0.30, dy: 0.15, read: 0.25, fastballFamily: true },
  slider: { name: 'スライダー', dx: 0.65, dy: 0.10, read: 0.45 },
  cutter: { name: 'カットボール', dx: 0.32, dy: 0.05, read: 0.32 },
  curve: { name: 'カーブ', dx: 0.40, dy: 0.65, read: 0.55 },
  fork: { name: 'フォーク', dx: 0, dy: 0.80, read: 0.65 },
  splitter: { name: 'スプリット', dx: 0, dy: 0.55, read: 0.55 },
  palm: { name: 'パーム', dx: 0, dy: 0.60, read: 0.60 },
  shoot: { name: 'シュート', dx: -0.45, dy: 0.40, read: 0.45 },
  sinker: { name: 'シンカー', dx: -0.38, dy: 0.62, read: 0.52 },
  changeup: { name: 'チェンジアップ', dx: -0.10, dy: 0.35, read: 0.60 },
};

/**
 * 球種の変化方向（パワプロ表記・右投手。投手目線の矢印。左投手は左右反転 → engine.pitchDirection）。
 * 画面上の実際の動き（dx/dy）は打者カメラ視点なので左右が逆になる（例: スライダー '←' は dx>0 = 画面右へ）。
 * ストレート系は '↑'（ノビ）、ツーシームは '→'（小さく）。
 */
export const PITCH_DIRECTIONS = {
  fastball: '↑',
  twoseam: '→',
  slider: '←',
  cutter: '←',
  curve: '↙',
  fork: '↓',
  splitter: '↓',
  palm: '↓',
  shoot: '→',
  sinker: '↘',
  changeup: '↓',
};

/**
 * 特殊能力。type: gold=金特 / blue=青特 / red=赤特、target: 対象（batter=野手・打者、pitcher=投手、any=両方）。
 * 効果の数値は docs/ENGINE-API.md「特殊能力」の表を参照（engine.js の SKILL_FX）。
 */
export const SKILLS = {
  // ── 野手（青）
  'チャンス◎': { type: 'blue', target: 'batter', desc: '得点圏で打撃向上' },
  '対左投手◎': { type: 'blue', target: 'batter', desc: '左投手に強い' },
  '盗塁◎': { type: 'blue', target: 'batter', desc: '盗塁のスタート・成功率↑' },
  '走塁◎': { type: 'blue', target: 'batter', desc: '走塁が速く積極的' },
  '送球◎': { type: 'blue', target: 'batter', desc: '送球が速く正確（捕手は盗塁阻止↑）' },
  'パワーヒッター': { type: 'blue', target: 'batter', desc: '弾道が高く飛距離↑・本塁打↑' },
  'アベレージヒッター': { type: 'blue', target: 'batter', desc: 'ヒット性の当たり↑' },
  '広角打法': { type: 'blue', target: 'batter', desc: '逆方向にも長打が出る' },
  '流し打ち': { type: 'blue', target: 'batter', desc: '逆方向へのヒット↑' },
  '初球○': { type: 'blue', target: 'batter', desc: '初球に強い' },
  '粘り打ち': { type: 'blue', target: 'batter', desc: '2ストライク後ファウルで粘る' },
  'バント◎': { type: 'blue', target: 'batter', desc: 'バントが上手い' },
  '選球眼': { type: 'blue', target: 'batter', desc: 'ボール球に手を出さない' },
  'キャッチャー◎': { type: 'blue', target: 'batter', desc: '捕手として盗塁阻止・配球が上手い' },
  // ── 野手（赤）
  'チャンス×': { type: 'red', target: 'batter', desc: '得点圏で打撃低下' },
  '三振': { type: 'red', target: 'batter', desc: '空振りが多い' },
  '併殺': { type: 'red', target: 'batter', desc: '併殺打が多い' },
  'エラー': { type: 'red', target: 'batter', desc: '守備でエラーしやすい' },
  // ── 野手（金）
  '天才打者': { type: 'gold', target: 'batter', desc: 'ミートが大きく空振りしにくい天才' },
  '怪力': { type: 'gold', target: 'batter', desc: '本塁打が大幅に増える' },
  // ── 投手（青）
  'ノビ◎': { type: 'blue', target: 'pitcher', desc: 'ストレートで空振りを奪う' },
  'キレ◎': { type: 'blue', target: 'pitcher', desc: '変化球で空振りを奪う' },
  '奪三振': { type: 'blue', target: 'pitcher', desc: '追い込むと決め球の威力↑' },
  '対ピンチ◎': { type: 'blue', target: 'pitcher', desc: '得点圏で被打率↓' },
  '重い球': { type: 'blue', target: 'pitcher', desc: '長打を打たれにくい' },
  'クイック◎': { type: 'blue', target: 'pitcher', desc: '盗塁されにくい' },
  '牽制◎': { type: 'blue', target: 'pitcher', desc: 'ランナーのリードを小さくする' },
  '打たれ強さ◎': { type: 'blue', target: 'pitcher', desc: '走者を背負っても崩れない' },
  '低め◎': { type: 'blue', target: 'pitcher', desc: '低めの制球が良くゴロを打たせる' },
  '対左打者◎': { type: 'blue', target: 'pitcher', desc: '左打者に強い' },
  // ── 投手（赤）
  '一発': { type: 'red', target: 'pitcher', desc: '本塁打を打たれやすい' },
  '四球': { type: 'red', target: 'pitcher', desc: '制球が乱れやすい' },
  'スロースターター': { type: 'red', target: 'pitcher', desc: '序盤（1〜2回）に不安定' },
  // ── 投手（金）
  '怪物球威': { type: 'gold', target: 'pitcher', desc: '怪物級の球威で打球が飛ばない' },
};

/**
 * 選手の総合力からコスト（1〜15 の整数）を算出（チームコストモード用）。
 * 野手: 総合 = ミート×0.30 + パワー×0.30 + 走力×0.14 + 守備×0.12 + 肩×0.07 + 捕球×0.07
 * 投手: 総合 = 球速能力×0.40 + コントロール×0.40 + スタミナ×0.15 + 変化量合計×1.2 + 6（球速能力=(km/h-120)/50×99）
 * 特殊能力: 金 +6、青 +1.5、赤 -2.5（野手は野手用・投手は投手用の能力のみ数える）
 * コスト = clamp(round((総合 - 40) / 3.2), 1, 15)
 * （平均的な主力 ≒ 7〜9、控え ≒ 3〜5、エース・主砲 ≒ 11〜13。25人で約150〜220）
 * @param {object} player
 * @returns {number}
 */
export function playerCost(player) {
  if (!player) return 1;
  let ov;
  const sk = Array.isArray(player.skills) ? player.skills : [];
  const kind = player.pitching ? 'pitcher' : 'batter';
  if (player.pitching) {
    const pt = player.pitching;
    const vel = Math.max(1, Math.min(99, ((pt.velocity - 120) / 50) * 99));
    const brk = (pt.pitches || []).reduce((a, q) => a + (q.level || 0), 0);
    ov = vel * 0.40 + pt.control * 0.40 + pt.stamina * 0.15 + brk * 1.2 + 6;
  } else {
    ov = player.contact * 0.30 + player.power * 0.30 + player.speed * 0.14
      + player.fielding * 0.12 + player.arm * 0.07 + player.catching * 0.07;
  }
  for (const name of sk) {
    const def = SKILLS[name];
    if (!def || (def.target !== 'any' && def.target !== kind)) continue;
    ov += def.type === 'gold' ? 6 : def.type === 'blue' ? 1.5 : -2.5;
  }
  return Math.max(1, Math.min(15, Math.round((ov - 40) / 3.2)));
}

/** ランク色 */
export const RANK_COLORS = {
  S: '#FF4FA3', A: '#E53935', B: '#F57C00', C: '#FDD835',
  D: '#43A047', E: '#1E88E5', F: '#757575', G: '#9E9E9E',
};

/** 文字色を濃色（navy）にすべきランク */
export const RANK_TEXT_DARK = ['C'];

/**
 * 能力値→ランク
 * @param {number} v 1-99
 * @returns {'S'|'A'|'B'|'C'|'D'|'E'|'F'|'G'}
 */
export function rank(v) {
  if (v >= 90) return 'S';
  if (v >= 80) return 'A';
  if (v >= 70) return 'B';
  if (v >= 60) return 'C';
  if (v >= 50) return 'D';
  if (v >= 40) return 'E';
  if (v >= 20) return 'F';
  return 'G';
}

/** 球種リスト生成ヘルパー */
const P = (...list) => list.map(([type, level]) => ({ type, name: PITCH_TYPES[type].name, level }));


/* ------------------------------------------------------------------ */
/* レッドスターズ（現役NPBスター軍）                                     */
/* ------------------------------------------------------------------ */
const RED_PLAYERS = [
  { id: 'r1', name: '速水 翔', number: 1, pos: '中', positions: ['中', '左', '右'], bats: '左', throws: '左', age: 30, trajectory: 2,
    contact: 70, power: 48, speed: 84, arm: 60, fielding: 80, catching: 74, pitching: null,
    skills: ['盗塁◎', '走塁◎', '初球○'],
    model: 'NPB 盗塁王・最多安打の常連、左の俊足リードオフ中堅手タイプ（打率.290前後・30盗塁級・日本シリーズMVP）' },
  { id: 'r2', name: '小野 拓真', number: 4, pos: '二', positions: ['二', '一', '三'], bats: '右', throws: '右', age: 27, trajectory: 3,
    contact: 66, power: 66, speed: 46, arm: 62, fielding: 62, catching: 68, pitching: null,
    skills: ['チャンス◎', '広角打法'],
    model: 'NPB 2023年 打点王・最多安打の強打の二塁手タイプ（打率.293・29本・103打点、新人から4年連続20本塁打超）' },
  { id: 'r3', name: '白石 蓮', number: 31, pos: '右', positions: ['右', '三', '左'], bats: '左', throws: '右', age: 26, trajectory: 4,
    contact: 63, power: 80, speed: 60, arm: 76, fielding: 58, catching: 58, pitching: null,
    skills: ['パワーヒッター', '三振'],
    model: 'NPB 2025年 本塁打王・打点王の左の大砲タイプ（40本・102打点・三振多め、右翼・三塁兼用）' },
  { id: 'r4', name: '赤城 大地', number: 44, pos: '一', positions: ['一', '三', '左'], bats: '右', throws: '右', age: 29, trajectory: 3,
    contact: 66, power: 80, speed: 38, arm: 64, fielding: 62, catching: 68, pitching: null,
    skills: ['パワーヒッター', 'チャンス◎'],
    model: 'NPB 本塁打王3度・6年連続30本塁打の右の4番タイプ（2023年 打率.278・41本・93打点、一塁・三塁兼用）' },
  { id: 'r5', name: '黒木 剣', number: 5, pos: '三', positions: ['三', '一'], bats: '左', throws: '右', age: 26, trajectory: 4,
    contact: 75, power: 88, speed: 44, arm: 70, fielding: 54, catching: 56, pitching: null,
    skills: ['パワーヒッター', '三振'],
    model: 'NPB 2022年 三冠王の若き大砲タイプ（史上最年少の三冠王／打率.318・56本・134打点、三振も多い）' },
  { id: 'r6', name: '緑川 悠', number: 7, pos: '左', positions: ['左', '右', '一'], bats: '左', throws: '右', age: 32, trajectory: 2,
    contact: 72, power: 60, speed: 48, arm: 60, fielding: 60, catching: 64, pitching: null,
    skills: ['選球眼', '広角打法'],
    model: 'NPB 最高出塁率の常連・2023年 本塁打王＆打点王の左の好打者タイプ（打率.303・26本・出塁率.431）' },
  { id: 'r7', name: '石田 慎', number: 27, pos: '捕', positions: ['捕'], bats: '右', throws: '右', age: 33, trajectory: 2,
    contact: 47, power: 44, speed: 32, arm: 90, fielding: 74, catching: 76, pitching: null,
    skills: ['キャッチャー◎', '送球◎', 'バント◎'],
    model: 'NPB 日本シリーズで6連続盗塁阻止しMVPの強肩捕手タイプ（打率.230前後・ゴールデングラブ常連・盗塁阻止率リーグ1位常連）' },
  { id: 'r8', name: '水野 航', number: 10, pos: '遊', positions: ['遊', '二', '三'], bats: '左', throws: '右', age: 32, trajectory: 1,
    contact: 57, power: 32, speed: 72, arm: 72, fielding: 90, catching: 86, pitching: null,
    skills: ['送球◎', 'バント◎', '走塁◎'],
    model: 'NPB ゴールデングラブ常連の守備職人遊撃手タイプ（新人年に全試合フルイニング出場・打率.270前後・守備範囲は球界屈指）' },
  { id: 'r9', name: '桜井 光', number: 38, pos: '三', positions: ['三', '一'], bats: '右', throws: '右', age: 35, trajectory: 2,
    contact: 70, power: 56, speed: 28, arm: 60, fielding: 56, catching: 64, pitching: null,
    skills: ['アベレージヒッター', '粘り打ち'],
    model: 'NPB 首位打者2度・三振の少ない右の巧打者タイプ（控え／2023年 34歳で打率.326、代打の切り札）' },
  // 投手陣（先発, 先発, 中継ぎ, 抑え ＋ 下に中継ぎ2人）
  { id: 'r10', name: '青山 剛', number: 18, pos: '投', positions: ['投'], bats: '右', throws: '右', age: 25, trajectory: 1,
    contact: 16, power: 20, speed: 36, arm: 76, fielding: 52, catching: 50,
    pitching: { role: 'starter', velocity: 148, control: 66, stamina: 84, pitches: P(['fork', 5], ['slider', 4], ['curve', 2]) },
    skills: ['奪三振', 'ノビ◎'],
    model: 'NPB 2022年 最多奪三振の本格派右腕タイプ（平均148km/h・ゾーンから消えるフォーク・年間170回超）' },
  { id: 'r11', name: '真壁 透', number: 21, pos: '投', positions: ['投'], bats: '左', throws: '左', age: 28, trajectory: 1,
    contact: 14, power: 14, speed: 32, arm: 62, fielding: 58, catching: 56,
    pitching: { role: 'starter', velocity: 144, control: 78, stamina: 82, pitches: P(['changeup', 4], ['slider', 4], ['twoseam', 3], ['curve', 2]) },
    skills: ['低め◎', '対ピンチ◎'],
    model: 'NPB 2023年 最多勝の精密機械左腕タイプ（16勝3敗・与四球率1点台・多彩な変化球）' },
  { id: 'r12', name: '藤代 晴', number: 41, pos: '投', positions: ['投'], bats: '左', throws: '右', age: 25, trajectory: 1,
    contact: 12, power: 14, speed: 34, arm: 74, fielding: 50, catching: 50,
    pitching: { role: 'reliever', velocity: 153, control: 58, stamina: 40, pitches: P(['slider', 4], ['changeup', 3]) },
    skills: ['重い球', '打たれ強さ◎'],
    model: 'NPB 160km/hを計測する剛腕セットアッパータイプ（2022年 最優秀中継ぎ・39試合連続無失点の記録も）' },
  { id: 'r13', name: '灰谷 進', number: 15, pos: '投', positions: ['投'], bats: '右', throws: '右', age: 26, trajectory: 1,
    contact: 10, power: 12, speed: 32, arm: 74, fielding: 48, catching: 50,
    pitching: { role: 'closer', velocity: 153, control: 62, stamina: 32, pitches: P(['fork', 5], ['slider', 3]) },
    skills: ['対ピンチ◎', '重い球'],
    model: 'NPB 新人で37セーブ（新人タイ記録）の守護神タイプ（スリークォーターから平均155km/h・フォーク）' },
  { id: 'r14', name: '柏木 隼人', number: 47, pos: '投', positions: ['投'], bats: '左', throws: '左', age: 26, trajectory: 1,
    contact: 12, power: 12, speed: 34, arm: 66, fielding: 54, catching: 52,
    pitching: { role: 'reliever', velocity: 146, control: 64, stamina: 36, pitches: P(['slider', 4], ['curve', 3], ['changeup', 2]) },
    skills: ['対左打者◎', 'クイック◎'],
    model: 'NPB 2024年 最優秀中継ぎの左腕タイプ（平均148km/h・70登板級・左打者に強い）' },
  { id: 'r15', name: '早瀬 圭', number: 36, pos: '投', positions: ['投'], bats: '右', throws: '右', age: 28, trajectory: 1,
    contact: 12, power: 14, speed: 36, arm: 70, fielding: 50, catching: 48,
    pitching: { role: 'reliever', velocity: 147, control: 70, stamina: 40, pitches: P(['fork', 3], ['slider', 3], ['curve', 2]) },
    skills: ['ノビ◎', '打たれ強さ◎'],
    model: 'NPB 2025年 50試合連続無失点の日本記録を作ったセットアッパータイプ（平均149km/h・与四球率1点台）' },
  // 控え野手（代打の切り札 r9 ＋ 代走・控え捕手・ユーティリティ2人）
  { id: 'r16', name: '疾風 走', number: 0, pos: '中', positions: ['中', '左', '右', '遊'], bats: '左', throws: '右', age: 29, trajectory: 1,
    contact: 50, power: 32, speed: 97, arm: 62, fielding: 74, catching: 66, pitching: null,
    skills: ['盗塁◎', '走塁◎'],
    model: 'NPB 13試合連続盗塁の世界記録を持つ韋駄天タイプ（控え／盗塁王複数回・代走の切り札・内外野を守る）' },
  { id: 'r17', name: '岩永 守', number: 32, pos: '捕', positions: ['捕'], bats: '右', throws: '右', age: 31, trajectory: 1,
    contact: 44, power: 34, speed: 34, arm: 70, fielding: 74, catching: 80, pitching: null,
    skills: ['キャッチャー◎', 'バント◎'],
    model: 'NPB 投手陣の信頼が厚い守備型捕手タイプ（控え中心から優勝チームの正捕手へ／打率.230前後・ブロッキング◎）' },
  { id: 'r18', name: '宮坂 誠', number: 2, pos: '二', positions: ['二', '遊', '三'], bats: '左', throws: '右', age: 29, trajectory: 1,
    contact: 66, power: 34, speed: 76, arm: 62, fielding: 74, catching: 76, pitching: null,
    skills: ['盗塁◎', 'バント◎'],
    model: 'NPB 2021年 盗塁王・2023年 最多安打の俊足巧打の内野手タイプ（控え／遊撃から二塁に転向しゴールデングラブ）' },
  { id: 'r19', name: '森 健吾', number: 35, pos: '一', positions: ['一', '捕', '三'], bats: '右', throws: '右', age: 29, trajectory: 3,
    contact: 64, power: 62, speed: 28, arm: 64, fielding: 48, catching: 58, pitching: null,
    skills: ['アベレージヒッター', '対左投手◎'],
    model: 'NPB 2023年 首位打者の右の強打者タイプ（控え／打率.307・16本、捕手・一塁・三塁を守った）' },
];

/* ------------------------------------------------------------------ */
/* ブルーウェーブス（MLB軍：MLBで活躍した日本人＋MLBのスター）           */
/* ------------------------------------------------------------------ */
const BLUE_PLAYERS = [
  { id: 'b1', name: '風間 颯', number: 2, pos: '遊', positions: ['遊', '二', '三'], bats: '右', throws: '右', age: 25, trajectory: 3,
    contact: 66, power: 64, speed: 86, arm: 78, fielding: 76, catching: 70, pitching: null,
    skills: ['盗塁◎', '走塁◎'],
    model: 'MLB 2024年 首位打者の走攻守そろった若き遊撃手タイプ（打率.332・32本・31盗塁・ゴールドグラブ）' },
  { id: 'b2', name: '岬 優斗', number: 9, pos: '二', positions: ['二', '左'], bats: '右', throws: '右', age: 33, trajectory: 2,
    contact: 68, power: 50, speed: 64, arm: 56, fielding: 64, catching: 70, pitching: null,
    skills: ['アベレージヒッター', '初球○'],
    model: 'MLB 首位打者3度・シーズン200安打を重ねた小柄な安打製造機の二塁手タイプ（MVP年 打率.346・24本）' },
  { id: 'b3', name: '東 雅也', number: 23, pos: '右', positions: ['右', '中', '左'], bats: '左', throws: '右', age: 30, trajectory: 1,
    contact: 83, power: 40, speed: 88, arm: 86, fielding: 80, catching: 82, pitching: null,
    skills: ['天才打者', '盗塁◎', '送球◎'],
    model: '日米通算4367安打の安打製造機タイプ（MLBシーズン262安打・打率.350超・メジャー屈指の強肩の右翼手）' },
  { id: 'b4', name: '鬼塚 豪', number: 14, pos: '左', positions: ['左', '右'], bats: '左', throws: '右', age: 30, trajectory: 4,
    contact: 62, power: 88, speed: 80, arm: 90, fielding: 54, catching: 56, pitching: null,
    skills: ['怪力', 'パワーヒッター', '三振'],
    model: 'MLB 2021年 二刀流MVPタイプ（投打とも超一流／打者では史上初の50本塁打50盗塁、投げては160km/h超の強肩）' },
  { id: 'b5', name: '霧島 健', number: 3, pos: '三', positions: ['三', '一'], bats: '右', throws: '右', age: 29, trajectory: 3,
    contact: 54, power: 72, speed: 38, arm: 84, fielding: 88, catching: 80, pitching: null,
    skills: ['送球◎', 'パワーヒッター'],
    model: 'MLB 三塁手で10年連続ゴールドグラブ・本塁打王3度の強打好守タイプ（40本塁打級・強肩）' },
  { id: 'b6', name: '北條 隆', number: 10, pos: '中', positions: ['中', '右', '左'], bats: '右', throws: '右', age: 30, trajectory: 4,
    contact: 60, power: 86, speed: 46, arm: 74, fielding: 58, catching: 60, pitching: null,
    skills: ['パワーヒッター', '選球眼', '三振'],
    model: 'MLB 2022年 ア・リーグ新記録の62本塁打を放った右の巨漢スラッガータイプ（四球も三振も多い・中堅も守る）' },
  { id: 'b7', name: '谷口 誠', number: 8, pos: '一', positions: ['一', '右'], bats: '左', throws: '右', age: 34, trajectory: 2,
    contact: 64, power: 58, speed: 40, arm: 56, fielding: 62, catching: 72, pitching: null,
    skills: ['チャンス◎', '広角打法'],
    model: 'MLB 2024年 ワールドシリーズ初戦でサヨナラ満塁本塁打を放った左の好打者一塁手タイプ（打率.300前後・二塁打量産）' },
  { id: 'b8', name: '南 大樹', number: 22, pos: '捕', positions: ['捕'], bats: '右', throws: '右', age: 31, trajectory: 2,
    contact: 42, power: 44, speed: 28, arm: 86, fielding: 80, catching: 86, pitching: null,
    skills: ['キャッチャー◎'],
    model: 'MLB ゴールドグラブ9度・強肩と投手リードで一時代を築いた名捕手タイプ（打率.280前後・盗塁阻止率リーグ上位常連）' },
  { id: 'b9', name: '千早 陸', number: 38, pos: '左', positions: ['左', '一'], bats: '左', throws: '右', age: 31, trajectory: 2,
    contact: 72, power: 54, speed: 38, arm: 50, fielding: 48, catching: 56, pitching: null,
    skills: ['アベレージヒッター', '選球眼'],
    model: 'NPB 首位打者2度、MLBでも打率.280超の三振しない左の巧打者タイプ（控え／WBC大会最多打点・代打の切り札）' },
  // 投手陣（先発, 先発, 中継ぎ, 抑え ＋ 下に中継ぎ2人）
  { id: 'b10', name: '海野 隼', number: 11, pos: '投', positions: ['投'], bats: '右', throws: '右', age: 27, trajectory: 1,
    contact: 14, power: 16, speed: 38, arm: 78, fielding: 60, catching: 56,
    pitching: { role: 'starter', velocity: 152, control: 74, stamina: 86, pitches: P(['splitter', 6], ['curve', 5], ['cutter', 3]) },
    skills: ['キレ◎', 'ノビ◎'],
    model: 'NPB 3年連続投手4冠＆沢村賞、MLB 2025年 ワールドシリーズMVPの右腕エースタイプ（平均153km/h・スプリット・大きなカーブ）' },
  { id: 'b11', name: '雪村 蒼', number: 47, pos: '投', positions: ['投'], bats: '右', throws: '右', age: 27, trajectory: 1,
    contact: 14, power: 18, speed: 30, arm: 70, fielding: 50, catching: 50,
    pitching: { role: 'starter', velocity: 146, control: 56, stamina: 86, pitches: P(['fork', 7], ['slider', 2]) },
    skills: ['奪三振', '四球'],
    model: 'MLB 日本人メジャーの先駆け、新人王・両リーグでノーヒットノーランの右腕タイプ（体を大きくひねる独特のフォーム・落差の大きいフォーク・奪三振王2度）' },
  { id: 'b12', name: '朝比奈 迅', number: 34, pos: '投', positions: ['投'], bats: '右', throws: '右', age: 38, trajectory: 1,
    contact: 10, power: 12, speed: 30, arm: 60, fielding: 54, catching: 54,
    pitching: { role: 'reliever', velocity: 139, control: 82, stamina: 36, pitches: P(['splitter', 6]) },
    skills: ['キレ◎', '打たれ強さ◎'],
    model: 'MLB 2013年 世界一チームの守護神、与四球率1点前後の精密右腕タイプ（平均140km/h台前半でも空振りを奪う切れ味鋭いスプリット）' },
  { id: 'b13', name: '剣持 雷', number: 19, pos: '投', positions: ['投'], bats: '右', throws: '右', age: 35, trajectory: 1,
    contact: 10, power: 12, speed: 32, arm: 70, fielding: 56, catching: 52,
    pitching: { role: 'closer', velocity: 149, control: 75, stamina: 32, pitches: P(['cutter', 7]) },
    skills: ['怪物球威', '対ピンチ◎'],
    model: 'MLB 通算652セーブの史上最多記録を持つ守護神タイプ（カットボール1球種で打者を圧倒し、バットを次々と折る球威）' },
  { id: 'b14', name: '橘 涼介', number: 13, pos: '投', positions: ['投'], bats: '右', throws: '右', age: 24, trajectory: 1,
    contact: 10, power: 12, speed: 34, arm: 80, fielding: 52, catching: 50,
    pitching: { role: 'reliever', velocity: 153, control: 56, stamina: 42, pitches: P(['splitter', 6], ['slider', 3]) },
    skills: ['ノビ◎', '奪三振'],
    model: 'NPB 完全試合＆165km/hの剛腕、MLB 1年目のポストシーズンでリリーフとして躍動した右腕タイプ（スプリット）' },
  { id: 'b15', name: '小早川 楓', number: 28, pos: '投', positions: ['投'], bats: '左', throws: '左', age: 30, trajectory: 1,
    contact: 10, power: 10, speed: 34, arm: 64, fielding: 52, catching: 50,
    pitching: { role: 'reliever', velocity: 145, control: 54, stamina: 34, pitches: P(['slider', 4], ['splitter', 4]) },
    skills: ['対左打者◎', '打たれ強さ◎'],
    model: 'NPB 史上最年少で200セーブに到達した左腕、MLBでもリリーフを務めるタイプ（平均146km/h・スライダー＆スプリット）' },
  // 控え野手（代打の千早 b9 ＋ 代走・控え捕手・ユーティリティ2人）
  { id: 'b16', name: '韋駄 天馬', number: 50, pos: '左', positions: ['左', '中', '右'], bats: '左', throws: '左', age: 32, trajectory: 1,
    contact: 46, power: 28, speed: 93, arm: 54, fielding: 70, catching: 66, pitching: null,
    skills: ['盗塁◎', '走塁◎'],
    model: 'MLB 2004年 ポストシーズン、9回の代走で伝説の二盗を決めた控え外野手タイプ（控え／盗塁成功率8割超）' },
  { id: 'b17', name: '堀 慎之介', number: 27, pos: '捕', positions: ['捕', '一'], bats: '右', throws: '右', age: 30, trajectory: 3,
    contact: 52, power: 52, speed: 40, arm: 76, fielding: 62, catching: 66, pitching: null,
    skills: ['送球◎'],
    model: 'MLB 日本人捕手として初の正捕手、1年目に18本塁打の強打の捕手タイプ（控え／NPB時代は打率.330・34本のシーズンも）' },
  { id: 'b18', name: '真田 凌', number: 4, pos: '遊', positions: ['遊', '二', '三'], bats: '左', throws: '右', age: 31, trajectory: 1,
    contact: 54, power: 30, speed: 76, arm: 66, fielding: 70, catching: 70, pitching: null,
    skills: ['バント◎', '走塁◎'],
    model: 'MLB 内野の全ポジションをこなしベンチを盛り上げた日本人内野手タイプ（控え／NPBでは最多安打＆盗塁王）' },
  { id: 'b19', name: '大河内 武', number: 33, pos: '右', positions: ['右', '左', '中'], bats: '右', throws: '右', age: 30, trajectory: 3,
    contact: 58, power: 64, speed: 58, arm: 74, fielding: 62, catching: 62, pitching: null,
    skills: ['パワーヒッター', '送球◎'],
    model: 'MLB 2025年 30本塁打・100打点超の強肩強打の右翼手タイプ（控え／NPBでは首位打者2度）' },
];

/* ------------------------------------------------------------------ */
/* グリーンファイターズ（昭和のレジェンドOB軍）                          */
/* ------------------------------------------------------------------ */
const GREEN_PLAYERS = [
  { id: 'g1', name: '青葉 駿', number: 12, pos: '中', positions: ['中', '左', '右'], bats: '左', throws: '左', age: 27, trajectory: 2,
    contact: 59, power: 42, speed: 96, arm: 60, fielding: 82, catching: 74, pitching: null,
    skills: ['盗塁◎', '走塁◎', '初球○'],
    model: 'シーズン106盗塁・通算1065盗塁の日本記録を持つ韋駄天リードオフタイプ（左の中堅手・ゴールデングラブ12度・先頭打者本塁打も多い）' },
  { id: 'g2', name: '萩原 匠', number: 4, pos: '二', positions: ['二', '三', '一'], bats: '左', throws: '右', age: 28, trajectory: 2,
    contact: 64, power: 38, speed: 52, arm: 60, fielding: 74, catching: 78, pitching: null,
    skills: ['流し打ち', 'アベレージヒッター'],
    model: '首位打者2度の流し打ちの名手、左の巧打二塁手タイプ（打率.300超の常連・華麗なグラブさばき）' },
  { id: 'g3', name: '日向 葵', number: 24, pos: '左', positions: ['左', '右', '一'], bats: '左', throws: '左', age: 30, trajectory: 3,
    contact: 80, power: 58, speed: 56, arm: 50, fielding: 48, catching: 56, pitching: null,
    skills: ['天才打者', '広角打法'],
    model: '日本記録の通算3085安打・首位打者7度の左の安打製造機タイプ（500本塁打・300盗塁も達成）' },
  { id: 'g4', name: '大門 剛志', number: 26, pos: '一', positions: ['一', '右'], bats: '左', throws: '左', age: 31, trajectory: 4,
    contact: 73, power: 92, speed: 40, arm: 56, fielding: 64, catching: 72, pitching: null,
    skills: ['怪力', 'パワーヒッター', '選球眼'],
    model: '通算868本塁打の世界記録保持者タイプ（一本足打法・本塁打王15度・三冠王2度・四球も歴代最多）' },
  { id: 'g5', name: '桐生 誠', number: 5, pos: '三', positions: ['三', '遊'], bats: '右', throws: '右', age: 30, trajectory: 3,
    contact: 67, power: 62, speed: 60, arm: 70, fielding: 72, catching: 64, pitching: null,
    skills: ['チャンス◎', '初球○'],
    model: '天覧試合でサヨナラ本塁打、首位打者6度・打点王5度の勝負強い国民的スター三塁手タイプ' },
  { id: 'g6', name: '島袋 海斗', number: 9, pos: '右', positions: ['右', '中', '左'], bats: '右', throws: '右', age: 32, trajectory: 3,
    contact: 54, power: 72, speed: 58, arm: 72, fielding: 76, catching: 70, pitching: null,
    skills: ['パワーヒッター'],
    model: '通算536本塁打・ゴールデングラブ10度の強打好守の外野手タイプ（本塁打王4度・打点王3度）' },
  { id: 'g7', name: '神崎 隼', number: 6, pos: '遊', positions: ['遊', '二', '三'], bats: '右', throws: '右', age: 27, trajectory: 1,
    contact: 48, power: 30, speed: 74, arm: 72, fielding: 90, catching: 86, pitching: null,
    skills: ['送球◎', 'バント◎'],
    model: '昭和の名遊撃手、捕ってから投げるまでが球界一速いと言われた小柄な守備の名手タイプ（通算350盗塁）' },
  { id: 'g8', name: '吉永 拓', number: 22, pos: '捕', positions: ['捕', '一'], bats: '右', throws: '右', age: 30, trajectory: 3,
    contact: 54, power: 72, speed: 30, arm: 70, fielding: 70, catching: 76, pitching: null,
    skills: ['キャッチャー◎', 'パワーヒッター'],
    model: '捕手で戦後初の三冠王・通算657本塁打の頭脳派捕手タイプ（本塁打王9度・配球の読みは球界随一）' },
  { id: 'g9', name: '倉持 大吾', number: 44, pos: '一', positions: ['一', '左'], bats: '右', throws: '右', age: 34, trajectory: 4,
    contact: 54, power: 74, speed: 28, arm: 52, fielding: 44, catching: 54, pitching: null,
    skills: ['初球○', 'パワーヒッター'],
    model: '代打本塁打27本の世界記録を持つ代打の切り札タイプ（控え／初球からフルスイング）' },
  // 投手陣（先発, 先発, 中継ぎ, 抑え ＋ 下に中継ぎ2人）
  { id: 'g10', name: '御堂 蓮司', number: 18, pos: '投', positions: ['投'], bats: '右', throws: '右', age: 24, trajectory: 1,
    contact: 22, power: 24, speed: 40, arm: 78, fielding: 62, catching: 58,
    pitching: { role: 'starter', velocity: 145, control: 78, stamina: 92, pitches: P(['slider', 6], ['shoot', 4]) },
    skills: ['打たれ強さ◎', '対ピンチ◎', 'キレ◎'],
    model: '日本シリーズ4連投4連勝の伝説の大エースタイプ（シーズン42勝・切れ味鋭いスライダーとシュート・連投に耐える無尽蔵のスタミナ）' },
  { id: 'g11', name: '早乙女 慧', number: 21, pos: '投', positions: ['投'], bats: '左', throws: '左', age: 26, trajectory: 1,
    contact: 24, power: 30, speed: 36, arm: 74, fielding: 56, catching: 52,
    pitching: { role: 'starter', velocity: 148, control: 60, stamina: 92, pitches: P(['curve', 6], ['changeup', 2]) },
    skills: ['怪物球威', '奪三振', '四球'],
    model: '前人未到の通算400勝・4490奪三振の大投手タイプ（長身から投げ下ろす剛速球と縦に割れるカーブの左腕・打撃も良い）' },
  { id: 'g12', name: '鷹野 鋭', number: 41, pos: '投', positions: ['投'], bats: '右', throws: '右', age: 30, trajectory: 1,
    contact: 12, power: 12, speed: 32, arm: 64, fielding: 60, catching: 56,
    pitching: { role: 'reliever', velocity: 138, control: 74, stamina: 55, pitches: P(['sinker', 6], ['shoot', 3], ['curve', 2]) },
    skills: ['低め◎', '重い球'],
    model: '通算284勝・3年連続MVPのアンダースロー、地をはうシンカーの名手タイプ（ロングリリーフで起用）' },
  { id: 'g13', name: '轟 武蔵', number: 15, pos: '投', positions: ['投'], bats: '左', throws: '左', age: 31, trajectory: 1,
    contact: 14, power: 20, speed: 30, arm: 70, fielding: 54, catching: 52,
    pitching: { role: 'closer', velocity: 144, control: 80, stamina: 38, pitches: P(['curve', 4], ['fork', 3], ['slider', 3]) },
    skills: ['対ピンチ◎', '打たれ強さ◎'],
    model: '日本シリーズで無死満塁を21球で切り抜けた伝説の左腕守護神タイプ（若き日にはシーズン401奪三振の日本記録も）' },
  { id: 'g14', name: '浅倉 夕', number: 47, pos: '投', positions: ['投'], bats: '左', throws: '左', age: 30, trajectory: 1,
    contact: 10, power: 10, speed: 32, arm: 58, fielding: 54, catching: 52,
    pitching: { role: 'reliever', velocity: 134, control: 68, stamina: 36, pitches: P(['curve', 4], ['sinker', 4]) },
    skills: ['対左打者◎', '牽制◎'],
    model: '昭和の左打者キラーとして知られたサイドスローの左腕タイプ（ワンポイントリリーフ起用の草分け）' },
  { id: 'g15', name: '鳴海 涼', number: 36, pos: '投', positions: ['投'], bats: '右', throws: '右', age: 29, trajectory: 1,
    contact: 12, power: 14, speed: 32, arm: 74, fielding: 50, catching: 50,
    pitching: { role: 'reliever', velocity: 146, control: 54, stamina: 52, pitches: P(['fork', 7]) },
    skills: ['奪三振', '四球'],
    model: '豪快なフォームから投げ込む宝刀フォークの右腕タイプ（通算215勝・40歳で二桁勝利、ロングリリーフで起用）' },
  // 控え野手（代打の切り札 g9 ＋ 代走・控え捕手・ユーティリティ2人）
  { id: 'g16', name: '飛鳥 迅', number: 0, pos: '中', positions: ['中', '左', '右'], bats: '右', throws: '右', age: 25, trajectory: 1,
    contact: 26, power: 14, speed: 99, arm: 56, fielding: 60, catching: 54, pitching: null,
    skills: ['走塁◎'],
    model: '五輪の短距離代表からプロ入りした代走専門のスプリンタータイプ（控え／足は球界最速、盗塁技術と打撃は未熟）' },
  { id: 'g17', name: '辰巳 鉄平', number: 37, pos: '捕', positions: ['捕'], bats: '左', throws: '右', age: 32, trajectory: 1,
    contact: 48, power: 36, speed: 34, arm: 70, fielding: 74, catching: 82, pitching: null,
    skills: ['キャッチャー◎', 'バント◎'],
    model: '9年連続日本一を支えた守備と頭脳の名捕手タイプ（控え／打率.230前後・リード評価◎）' },
  { id: 'g18', name: '水無瀬 聡', number: 2, pos: '二', positions: ['二', '遊', '三'], bats: '右', throws: '右', age: 29, trajectory: 2,
    contact: 58, power: 40, speed: 72, arm: 66, fielding: 84, catching: 80, pitching: null,
    skills: ['送球◎', '盗塁◎'],
    model: '華麗なバックトスで鳴らした俊足好守の二塁手タイプ（控え／通算2274安打・盗塁王複数回）' },
  { id: 'g19', name: '早川 陸斗', number: 31, pos: '三', positions: ['三', '一', '二'], bats: '右', throws: '右', age: 33, trajectory: 3,
    contact: 76, power: 76, speed: 34, arm: 62, fielding: 50, catching: 60, pitching: null,
    skills: ['天才打者', '選球眼'],
    model: '史上唯一3度の三冠王に輝いた右の天才打者タイプ（控え／神主打法・打率.367・52本のシーズンも）' },
];

/* ------------------------------------------------------------------ */
/* イエローサンダース（平成のOB・名手軍）                                */
/* ------------------------------------------------------------------ */
const YELLOW_PLAYERS = [
  { id: 'y1', name: '虎尾 晴樹', number: 1, pos: '中', positions: ['中', '左', '右'], bats: '左', throws: '右', age: 27, trajectory: 1,
    contact: 64, power: 30, speed: 94, arm: 56, fielding: 80, catching: 74, pitching: null,
    skills: ['盗塁◎', '走塁◎', 'バント◎'],
    model: '新人から5年連続盗塁王の小柄な韋駄天中堅手タイプ（打率.300前後・シーズン60盗塁超・中堅の守備範囲は球界屈指）' },
  { id: 'y2', name: '雷門 和真', number: 9, pos: '遊', positions: ['遊', '三', '二'], bats: '右', throws: '右', age: 32, trajectory: 1,
    contact: 54, power: 32, speed: 60, arm: 76, fielding: 86, catching: 86, pitching: null,
    skills: ['バント◎', '送球◎', '流し打ち'],
    model: '通算400犠打超・ゴールデングラブ10度の守備と小技の名手遊撃手タイプ（2000安打も達成）' },
  { id: 'y3', name: '金城 獅童', number: 10, pos: '右', positions: ['右', '左', '中'], bats: '左', throws: '右', age: 28, trajectory: 3,
    contact: 74, power: 58, speed: 54, arm: 70, fielding: 66, catching: 66, pitching: null,
    skills: ['広角打法', 'アベレージヒッター'],
    model: '大けがを乗り越え2000安打に到達した、球界屈指の美しいスイングの左の巧打者タイプ（打率.300超の常連）' },
  { id: 'y4', name: '巌 大吾郎', number: 30, pos: '一', positions: ['一', '左'], bats: '左', throws: '左', age: 30, trajectory: 4,
    contact: 74, power: 82, speed: 34, arm: 56, fielding: 52, catching: 62, pitching: null,
    skills: ['パワーヒッター', 'チャンス◎'],
    model: '平成唯一の三冠王の左の4番一塁手タイプ（2004年 打率.358・44本・120打点）' },
  { id: 'y5', name: '鳳 隆二', number: 25, pos: '左', positions: ['左', '中', '右'], bats: '左', throws: '右', age: 28, trajectory: 4,
    contact: 68, power: 86, speed: 46, arm: 64, fielding: 62, catching: 66, pitching: null,
    skills: ['怪力', '選球眼'],
    model: '2002年 50本塁打・日米通算507本の左の長距離砲タイプ（MLBではワールドシリーズMVP・四球も多い）' },
  { id: 'y6', name: '稲妻 健', number: 23, pos: '三', positions: ['三', '一'], bats: '右', throws: '右', age: 28, trajectory: 4,
    contact: 56, power: 80, speed: 40, arm: 80, fielding: 70, catching: 64, pitching: null,
    skills: ['パワーヒッター', '三振'],
    model: '2001年 46本塁打・132打点、フルスイングの右の豪快な三塁手タイプ（強肩・ゴールデングラブも受賞、三振も多い）' },
  { id: 'y7', name: '黄瀬 翼', number: 4, pos: '二', positions: ['二', '遊', '中'], bats: '右', throws: '右', age: 30, trajectory: 1,
    contact: 54, power: 28, speed: 82, arm: 62, fielding: 84, catching: 80, pitching: null,
    skills: ['盗塁◎', '送球◎'],
    model: 'ゴールデングラブ6度・盗塁王の俊足好守の二塁手タイプ（鉄壁の二遊間コンビの片割れ・2000安打）' },
  { id: 'y8', name: '熊谷 豪', number: 2, pos: '捕', positions: ['捕', '一'], bats: '右', throws: '右', age: 30, trajectory: 2,
    contact: 64, power: 54, speed: 40, arm: 88, fielding: 80, catching: 84, pitching: null,
    skills: ['キャッチャー◎', '送球◎', 'アベレージヒッター'],
    model: '捕手で首位打者・シーズン盗塁阻止率.644の日本記録を持つ頭脳派捕手タイプ（ゴールデングラブ10度）' },
  { id: 'y9', name: '番場 豊', number: 44, pos: '右', positions: ['右', '左', '一'], bats: '左', throws: '右', age: 38, trajectory: 2,
    contact: 66, power: 58, speed: 36, arm: 56, fielding: 50, catching: 56, pitching: null,
    skills: ['チャンス◎', '初球○'],
    model: '晩年は代打一筋、勝負強さで球場を沸かせた左の代打の切り札タイプ（控え／代打で積み上げた安打はリーグ屈指）' },
  // 投手陣（先発, 先発, 中継ぎ, 抑え ＋ 下に中継ぎ2人）
  { id: 'y10', name: '天城 豪', number: 17, pos: '投', positions: ['投'], bats: '右', throws: '右', age: 21, trajectory: 1,
    contact: 22, power: 28, speed: 40, arm: 82, fielding: 58, catching: 54,
    pitching: { role: 'starter', velocity: 152, control: 62, stamina: 88, pitches: P(['slider', 6], ['changeup', 3], ['curve', 2], ['cutter', 2]) },
    skills: ['ノビ◎', '対ピンチ◎'],
    model: '新人から3年連続最多勝の剛腕エースタイプ（平均150km/h超・切れ味鋭いスライダー、MLBでワールドシリーズ制覇）' },
  { id: 'y11', name: '月島 静', number: 11, pos: '投', positions: ['投'], bats: '左', throws: '左', age: 41, trajectory: 1,
    contact: 12, power: 12, speed: 26, arm: 56, fielding: 58, catching: 56,
    pitching: { role: 'starter', velocity: 136, control: 76, stamina: 82, pitches: P(['sinker', 6], ['curve', 4], ['slider', 3]) },
    skills: ['低め◎', '打たれ強さ◎'],
    model: '50歳まで現役、通算219勝のスクリューボールの名手左腕タイプ（史上最年長勝利・41歳でノーヒットノーラン）' },
  { id: 'y12', name: '赤羽 猛', number: 29, pos: '投', positions: ['投'], bats: '右', throws: '右', age: 25, trajectory: 1,
    contact: 10, power: 12, speed: 34, arm: 70, fielding: 50, catching: 50,
    pitching: { role: 'reliever', velocity: 148, control: 66, stamina: 40, pitches: P(['fork', 4], ['curve', 2]) },
    skills: ['ノビ◎', '対ピンチ◎'],
    model: '打者が分かっていても空振りする伸び上がる直球のセットアッパータイプ（2005年 80登板・防御率1点台）' },
  { id: 'y13', name: '鬼頭 雷蔵', number: 19, pos: '投', positions: ['投'], bats: '右', throws: '右', age: 30, trajectory: 1,
    contact: 10, power: 12, speed: 28, arm: 72, fielding: 48, catching: 50,
    pitching: { role: 'closer', velocity: 146, control: 68, stamina: 30, pitches: P(['fork', 7], ['curve', 2]) },
    skills: ['対ピンチ◎', '奪三振'],
    model: '日米通算381セーブ、落差の大きいフォークの守護神タイプ（1998年 日本一・防御率0点台、MLBでは新人王）' },
  { id: 'y14', name: '蜂谷 誠司', number: 34, pos: '投', positions: ['投'], bats: '右', throws: '右', age: 27, trajectory: 1,
    contact: 10, power: 12, speed: 34, arm: 70, fielding: 56, catching: 54,
    pitching: { role: 'reliever', velocity: 149, control: 64, stamina: 40, pitches: P(['fork', 4], ['slider', 3]) },
    skills: ['重い球', '打たれ強さ◎'],
    model: '中継ぎ投手としてリーグMVPに輝いたセットアッパータイプ（2011年 防御率0点台・150km/h超とフォーク）' },
  { id: 'y15', name: '向井 陽平', number: 28, pos: '投', positions: ['投'], bats: '左', throws: '左', age: 33, trajectory: 1,
    contact: 10, power: 10, speed: 30, arm: 62, fielding: 54, catching: 52,
    pitching: { role: 'reliever', velocity: 143, control: 70, stamina: 34, pitches: P(['slider', 6], ['twoseam', 3]) },
    skills: ['対左打者◎', '打たれ強さ◎'],
    model: '通算407セーブ・1002登板の日本記録を持つ左腕タイプ（打者の手元で鋭く曲がるスライダー）' },
  // 控え野手（代打 y9 ＋ 代走・控え捕手・ユーティリティ2人）
  { id: 'y16', name: '隼 疾人', number: 0, pos: '中', positions: ['中', '左', '右'], bats: '右', throws: '右', age: 30, trajectory: 1,
    contact: 46, power: 24, speed: 95, arm: 58, fielding: 72, catching: 66, pitching: null,
    skills: ['盗塁◎', '走塁◎'],
    model: '代走で通算228盗塁・盗塁成功率は歴代最高の代走のスペシャリストタイプ（控え）' },
  { id: 'y17', name: '牛島 大樹', number: 32, pos: '捕', positions: ['捕', '一'], bats: '右', throws: '右', age: 36, trajectory: 2,
    contact: 50, power: 54, speed: 30, arm: 78, fielding: 72, catching: 80, pitching: null,
    skills: ['キャッチャー◎', '送球◎'],
    model: '通算3021試合出場の日本記録を持つ捕手タイプ（控え／強肩・リード◎、打撃は勝負強い）' },
  { id: 'y18', name: '柊 恭平', number: 3, pos: '二', positions: ['二', '遊', '三', '一'], bats: '右', throws: '右', age: 33, trajectory: 1,
    contact: 60, power: 34, speed: 60, arm: 68, fielding: 80, catching: 82, pitching: null,
    skills: ['流し打ち', '送球◎'],
    model: 'ゴールデングラブ7度の守備の名手、国際大会で土壇場の同点打を放った右の内野手タイプ（控え／流し打ちと粘り強い打撃）' },
  { id: 'y19', name: '榊原 亮', number: 33, pos: '中', positions: ['中', '右', '左'], bats: '右', throws: '右', age: 29, trajectory: 3,
    contact: 50, power: 62, speed: 70, arm: 80, fielding: 78, catching: 76, pitching: null,
    skills: ['送球◎', '初球○'],
    model: 'ゴールデングラブ10度の強肩外野手、敬遠球をサヨナラ打にした意外性の男タイプ（控え／MLBでも活躍）' },
];

/**
 * チーム一覧。lineup = 打順（9番は先発投手、守備位置は player.pos）、
 * pitchers = 先発, 先発, 中継ぎ×3, 抑え（player.pitching.role が 'starter'|'reliever'|'closer'）、
 * bench = 控え野手5人（代打の切り札・代走・控え捕手・ユーティリティ2人）。計19人。
 * player.positions = 守れる守備位置（先頭が本職）。
 */
export const TEAMS = [
  {
    id: 'red', name: 'レッドスターズ', short: 'R', color: '#E5484D',
    lineup: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r10'],
    pitchers: ['r10', 'r11', 'r12', 'r14', 'r15', 'r13'],
    bench: ['r9', 'r16', 'r17', 'r18', 'r19'],
    players: RED_PLAYERS,
  },
  {
    id: 'blue', name: 'ブルーウェーブス', short: 'B', color: '#1E88E5',
    lineup: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b10'],
    pitchers: ['b10', 'b11', 'b12', 'b14', 'b15', 'b13'],
    bench: ['b9', 'b16', 'b17', 'b18', 'b19'],
    players: BLUE_PLAYERS,
  },
  {
    id: 'green', name: 'グリーンファイターズ', short: 'G', color: '#2E9E55',
    lineup: ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g10'],
    pitchers: ['g10', 'g11', 'g12', 'g14', 'g15', 'g13'],
    bench: ['g9', 'g16', 'g17', 'g18', 'g19'],
    players: GREEN_PLAYERS,
  },
  {
    id: 'yellow', name: 'イエローサンダース', short: 'Y', color: '#F2B705',
    lineup: ['y1', 'y2', 'y3', 'y4', 'y5', 'y6', 'y7', 'y8', 'y10'],
    pitchers: ['y10', 'y11', 'y12', 'y14', 'y15', 'y13'],
    bench: ['y9', 'y16', 'y17', 'y18', 'y19'],
    players: YELLOW_PLAYERS,
  },
];
