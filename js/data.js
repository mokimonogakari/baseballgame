/**
 * チーム・選手データ（ドキドキベースボール）
 * 純粋なデータ定義。DOM・エンジンには依存しない。
 *
 * ■ 選手名はすべて架空（肖像権・氏名権への配慮）。能力値は実在のプロ野球選手
 *   （NPB/MLB の近年の代表的なシーズン）の成績をモデルに換算し、`model` に
 *   「どのタイプの選手か（年・タイトル・成績の目安）」を記す。実名は記さない。
 *   成績は概数（記憶ベースの目安）であり、厳密な公式記録ではない。
 *
 * ■ 成績 → 能力値（1-99）の換算式（143試合フル出場換算、最後に 1-99 に丸め）
 *   打率   → contact  = 40 + (打率 - .220) × 400      （.300→72 / .250→52 / .320→80）
 *   本塁打 → power    = 40 + 本塁打 × 1.3              （35本→85 / 20本→66 / 5本→47）
 *   盗塁   → speed    = 40 + 盗塁 × 1.5（走塁評価で ±5）（30盗塁→85 / 5盗塁→48）
 *   球速   → velocity = 平均〜最速の中間 km/h をそのまま（エンジンで (km/h-120)/50×99 に換算）
 *   与四球率→ control  = 99 - (BB/9 - 1.0) × 20         （BB/9 2.0→79 / 3.0→59）
 *   投球回 → stamina  = 10 + 投球回 × 0.45            （170回→86 / 60回→37）
 *   守備指標→ fielding = 50 + UZR × 2 前後（守備範囲）、arm = 補殺・盗塁阻止率・送球評価、
 *             catching = 失策率の少なさ（守備率 .990 前後→70）
 *   弾道 trajectory 1-4 は打球角度（フライ率）の傾向から決定。
 *   投手の打撃能力は NPB の投手打撃（打率.100前後）から contact/power 20 前後。
 *
 * ■ 両チームの戦力: 野手平均・投手陣平均がほぼ同等になるよう調整
 *   （レッド＝長打力型、ブルー＝巧打・投手力型）。
 */

/** 球種定義（BALANCE.md）。dx/dy はゾーンセル単位（+x=右, +y=下）、read=見切り難度。右投手基準、左投手は dx 反転 */
export const PITCH_TYPES = {
  fastball: { name: 'ストレート', dx: 0, dy: 0, read: 0.15 },
  slider: { name: 'スライダー', dx: 0.65, dy: 0.10, read: 0.45 },
  curve: { name: 'カーブ', dx: 0.40, dy: 0.65, read: 0.55 },
  fork: { name: 'フォーク', dx: 0, dy: 0.80, read: 0.65 },
  shoot: { name: 'シュート', dx: -0.45, dy: 0.40, read: 0.45 },
  changeup: { name: 'チェンジアップ', dx: -0.10, dy: 0.35, read: 0.60 },
};

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
/* レッドスターズ（長打力型）                                           */
/* ------------------------------------------------------------------ */
const RED_PLAYERS = [
  { id: 'r1', name: '速水 翔', number: 1, pos: '中', positions: ['中', '左', '右'], bats: '左', throws: '左', age: 28, trajectory: 2,
    contact: 66, power: 50, speed: 82, arm: 62, fielding: 80, catching: 72, pitching: null,
    skills: ['盗塁○', '走塁○'],
    model: 'NPB 2023年 盗塁王タイプ（左の俊足リードオフ／打率.285・8本・28盗塁・中堅守備リーグ上位）' },
  { id: 'r2', name: '小野 拓真', number: 4, pos: '二', positions: ['二', '遊', '三'], bats: '左', throws: '右', age: 27, trajectory: 1,
    contact: 66, power: 44, speed: 70, arm: 64, fielding: 84, catching: 80, pitching: null,
    skills: ['バント○', '守備職人'],
    model: 'NPB 2023年 ゴールデングラブ二塁手タイプ（守備型の2番打者／打率.285・2本・20盗塁）' },
  { id: 'r3', name: '白石 蓮', number: 8, pos: '右', positions: ['右', '左', '一'], bats: '左', throws: '右', age: 30, trajectory: 3,
    contact: 74, power: 74, speed: 50, arm: 64, fielding: 58, catching: 60, pitching: null,
    skills: ['選球眼', 'アベレージヒッター'],
    model: 'NPB 2023年 最高出塁率タイプ（左の好打者／打率.303・26本・出塁率.431）' },
  { id: 'r4', name: '赤城 大地', number: 25, pos: '一', positions: ['一'], bats: '左', throws: '左', age: 29, trajectory: 3,
    contact: 72, power: 85, speed: 48, arm: 60, fielding: 52, catching: 63, pitching: null,
    skills: ['チャンス◎', 'パワーヒッター'],
    model: 'NPB 二冠王タイプ（左の4番長距離砲／打率.300・35本・100打点級）' },
  { id: 'r5', name: '黒木 剣', number: 5, pos: '三', positions: ['三', '一'], bats: '右', throws: '右', age: 27, trajectory: 4,
    contact: 56, power: 79, speed: 44, arm: 76, fielding: 60, catching: 58, pitching: null,
    skills: ['パワーヒッター', '三振'],
    model: 'NPB 右の大砲三塁手タイプ（打率.255・30本・三振多め）' },
  { id: 'r6', name: '緑川 悠', number: 7, pos: '左', positions: ['左', '右', '中'], bats: '右', throws: '右', age: 26, trajectory: 2,
    contact: 60, power: 60, speed: 62, arm: 60, fielding: 64, catching: 66, pitching: null,
    skills: ['流し打ち'],
    model: 'NPB 中距離型外野手タイプ（打率.270・15本・14盗塁）' },
  { id: 'r7', name: '石田 慎', number: 27, pos: '捕', positions: ['捕'], bats: '右', throws: '右', age: 31, trajectory: 2,
    contact: 52, power: 56, speed: 34, arm: 82, fielding: 72, catching: 78, pitching: null,
    skills: ['キャッチャー◎', 'ブロック○'],
    model: 'NPB 2023年 盗塁阻止率リーグ1位タイプ（強肩の正捕手／打率.240・12本・阻止率.400超）' },
  { id: 'r8', name: '水野 航', number: 6, pos: '遊', positions: ['遊', '二', '三'], bats: '右', throws: '右', age: 25, trajectory: 1,
    contact: 54, power: 44, speed: 70, arm: 76, fielding: 82, catching: 76, pitching: null,
    skills: ['守備職人', 'レーザービーム'],
    model: 'NPB 守備型遊撃手タイプ（打率.255・3本・20盗塁・UZRリーグ上位）' },
  { id: 'r9', name: '桜井 光', number: 31, pos: '右', positions: ['右', '左', '一'], bats: '左', throws: '右', age: 33, trajectory: 3,
    contact: 58, power: 64, speed: 46, arm: 56, fielding: 52, catching: 58, pitching: null,
    skills: ['代打○'],
    model: 'NPB 代打の切り札タイプ（控え／打率.260・代打本塁打リーグ上位）' },
  // 投手陣（先発, 先発, 中継ぎ, 抑え ＋ 下に中継ぎ2人）
  { id: 'r10', name: '青山 剛', number: 18, pos: '投', positions: ['投'], bats: '右', throws: '右', age: 26, trajectory: 1,
    contact: 18, power: 22, speed: 36, arm: 76, fielding: 52, catching: 50,
    pitching: { role: 'starter', velocity: 148, control: 62, stamina: 86, pitches: P(['slider', 3], ['fork', 2], ['curve', 2]) },
    skills: ['奪三振', 'ノビ○'],
    model: 'NPB 2023年 最多奪三振タイプ（右の本格派先発／平均148km/h・与四球率2.8・170回）' },
  { id: 'r11', name: '真壁 透', number: 21, pos: '投', positions: ['投'], bats: '左', throws: '左', age: 31, trajectory: 1,
    contact: 16, power: 18, speed: 30, arm: 64, fielding: 56, catching: 54,
    pitching: { role: 'starter', velocity: 142, control: 77, stamina: 80, pitches: P(['curve', 3], ['changeup', 3], ['slider', 2]) },
    skills: ['対ピンチ○', '低め○'],
    model: 'NPB 技巧派左腕先発タイプ（平均142km/h・与四球率2.1・155回・防御率2点台）' },
  { id: 'r12', name: '藤代 晴', number: 41, pos: '投', positions: ['投'], bats: '右', throws: '右', age: 28, trajectory: 1,
    contact: 12, power: 14, speed: 34, arm: 70, fielding: 50, catching: 50,
    pitching: { role: 'reliever', velocity: 152, control: 56, stamina: 38, pitches: P(['slider', 3], ['fork', 1]) },
    skills: ['重い球'],
    model: 'NPB 最優秀中継ぎタイプ（セットアッパー／平均152km/h・与四球率3.2・60登板60回）' },
  { id: 'r13', name: '灰谷 進', number: 15, pos: '投', positions: ['投'], bats: '右', throws: '右', age: 29, trajectory: 1,
    contact: 10, power: 12, speed: 32, arm: 72, fielding: 48, catching: 50,
    pitching: { role: 'closer', velocity: 155, control: 64, stamina: 32, pitches: P(['fork', 4], ['slider', 2]) },
    skills: ['対ピンチ○', '奪三振'],
    model: 'NPB 2023年 最多セーブタイプ（守護神／平均155km/h・高速フォーク・与四球率2.7・50回）' },
  { id: 'r14', name: '柏木 隼人', number: 47, pos: '投', positions: ['投'], bats: '左', throws: '左', age: 30, trajectory: 1,
    contact: 12, power: 12, speed: 34, arm: 64, fielding: 54, catching: 52,
    pitching: { role: 'reliever', velocity: 146, control: 68, stamina: 34, pitches: P(['slider', 3], ['curve', 2]) },
    skills: ['対左打者○', 'クイック○'],
    model: 'NPB 左の中継ぎタイプ（左キラー／平均146km/h・与四球率2.6・55登板50回・ホールド20級）' },
  { id: 'r15', name: '早瀬 圭', number: 36, pos: '投', positions: ['投'], bats: '右', throws: '右', age: 24, trajectory: 1,
    contact: 12, power: 14, speed: 38, arm: 70, fielding: 50, catching: 48,
    pitching: { role: 'reliever', velocity: 150, control: 54, stamina: 40, pitches: P(['fork', 2], ['slider', 2]) },
    skills: ['ノビ○'],
    model: 'NPB 若手ロングリリーフタイプ（平均150km/h・与四球率3.3・45登板65回）' },
  // 控え野手（代打の切り札 r9 ＋ 代走・控え捕手・ユーティリティ2人）
  { id: 'r16', name: '疾風 走', number: 0, pos: '中', positions: ['中', '左', '右'], bats: '左', throws: '右', age: 25, trajectory: 1,
    contact: 46, power: 30, speed: 95, arm: 60, fielding: 72, catching: 66, pitching: null,
    skills: ['盗塁◎', '走塁◎', '代走○'],
    model: 'NPB 代走のスペシャリストタイプ（控え／代走中心で年間20盗塁・盗塁成功率.900前後・打率.220）' },
  { id: 'r17', name: '岩永 守', number: 32, pos: '捕', positions: ['捕', '一'], bats: '右', throws: '右', age: 34, trajectory: 2,
    contact: 44, power: 48, speed: 30, arm: 72, fielding: 66, catching: 74, pitching: null,
    skills: ['キャッチャー○'],
    model: 'NPB ベテラン第2捕手タイプ（控え／打率.220・4本・リード評価高め）' },
  { id: 'r18', name: '宮坂 誠', number: 2, pos: '遊', positions: ['遊', '二', '三'], bats: '右', throws: '右', age: 29, trajectory: 1,
    contact: 54, power: 40, speed: 64, arm: 70, fielding: 74, catching: 74, pitching: null,
    skills: ['守備職人', 'バント○'],
    model: 'NPB 内野ユーティリティタイプ（控え／打率.250・2本・二遊間三塁を守る守備固め）' },
  { id: 'r19', name: '森 健吾', number: 44, pos: '三', positions: ['三', '一', '左', '右'], bats: '右', throws: '右', age: 31, trajectory: 2,
    contact: 58, power: 56, speed: 50, arm: 66, fielding: 58, catching: 62, pitching: null,
    skills: ['対左投手○'],
    model: 'NPB 内外野兼用ユーティリティタイプ（控え／打率.265・8本・対左投手に強い）' },
];

/* ------------------------------------------------------------------ */
/* ブルーウェーブス（巧打・投手力型）                                   */
/* ------------------------------------------------------------------ */
const BLUE_PLAYERS = [
  { id: 'b1', name: '風間 颯', number: 2, pos: '遊', positions: ['遊', '二', '三'], bats: '左', throws: '右', age: 26, trajectory: 2,
    contact: 64, power: 48, speed: 84, arm: 72, fielding: 78, catching: 72, pitching: null,
    skills: ['盗塁○', '内野安打○'],
    model: 'NPB 2024年 盗塁王タイプ（俊足の遊撃手リードオフ／打率.275・6本・30盗塁）' },
  { id: 'b2', name: '岬 優斗', number: 9, pos: '二', positions: ['二', '一', '三'], bats: '左', throws: '右', age: 29, trajectory: 2,
    contact: 78, power: 46, speed: 60, arm: 60, fielding: 70, catching: 74, pitching: null,
    skills: ['アベレージヒッター', '流し打ち'],
    model: 'NPB 2024年 首位打者タイプ（左の巧打者／打率.315・5本・三振少）' },
  { id: 'b3', name: '東 雅也', number: 51, pos: '中', positions: ['中', '左', '右'], bats: '右', throws: '右', age: 27, trajectory: 3,
    contact: 68, power: 72, speed: 74, arm: 72, fielding: 76, catching: 72, pitching: null,
    skills: ['走塁○', 'チャンス○'],
    model: 'MLB 走攻守三拍子タイプ（中堅手／打率.290・25本・25盗塁）' },
  { id: 'b4', name: '鬼塚 豪', number: 55, pos: '一', positions: ['一'], bats: '右', throws: '右', age: 28, trajectory: 4,
    contact: 62, power: 88, speed: 40, arm: 58, fielding: 48, catching: 56, pitching: null,
    skills: ['パワーヒッター', 'アーチスト'],
    model: 'NPB 2023年 本塁打王タイプ（右の長距離砲／打率.275・37本・三振多め）' },
  { id: 'b5', name: '霧島 健', number: 3, pos: '三', positions: ['三', '一'], bats: '左', throws: '右', age: 30, trajectory: 3,
    contact: 66, power: 72, speed: 46, arm: 70, fielding: 62, catching: 62, pitching: null,
    skills: ['チャンス○'],
    model: 'MLB 強打の三塁手タイプ（打率.280・25本・OPS.850前後）' },
  { id: 'b6', name: '北條 隆', number: 10, pos: '右', positions: ['右', '左', '中'], bats: '右', throws: '右', age: 27, trajectory: 3,
    contact: 54, power: 66, speed: 56, arm: 82, fielding: 66, catching: 64, pitching: null,
    skills: ['レーザービーム'],
    model: 'NPB 強肩外野手タイプ（打率.255・20本・補殺リーグ1位）' },
  { id: 'b7', name: '谷口 誠', number: 0, pos: '左', positions: ['左', '中', '右'], bats: '左', throws: '左', age: 24, trajectory: 2,
    contact: 58, power: 52, speed: 64, arm: 58, fielding: 66, catching: 66, pitching: null,
    skills: ['粘り打ち'],
    model: 'NPB 若手中堅外野手タイプ（打率.265・10本・16盗塁）' },
  { id: 'b8', name: '南 大樹', number: 22, pos: '捕', positions: ['捕'], bats: '右', throws: '右', age: 30, trajectory: 2,
    contact: 50, power: 58, speed: 34, arm: 76, fielding: 74, catching: 80, pitching: null,
    skills: ['キャッチャー◎', 'フレーミング○'],
    model: 'NPB 正捕手タイプ（打率.240・14本・フレーミング評価リーグ上位）' },
  { id: 'b9', name: '千早 陸', number: 38, pos: '左', positions: ['左', '一', '右'], bats: '右', throws: '右', age: 32, trajectory: 3,
    contact: 56, power: 66, speed: 44, arm: 60, fielding: 54, catching: 56, pitching: null,
    skills: ['代打○'],
    model: 'MLB 指名打者・代打型ベテランタイプ（控え／打率.250・代打で長打）' },
  // 投手陣（先発, 先発, 中継ぎ, 抑え ＋ 下に中継ぎ2人）
  { id: 'b10', name: '海野 隼', number: 11, pos: '投', positions: ['投'], bats: '右', throws: '右', age: 25, trajectory: 1,
    contact: 16, power: 20, speed: 38, arm: 78, fielding: 58, catching: 54,
    pitching: { role: 'starter', velocity: 150, control: 70, stamina: 86, pitches: P(['fork', 3], ['curve', 2], ['slider', 2]) },
    skills: ['キレ○', 'ノビ○'],
    model: 'NPB 投手三冠タイプ（右の完成型エース／平均150km/h・与四球率2.4・170回・防御率1点台）' },
  { id: 'b11', name: '雪村 蒼', number: 47, pos: '投', positions: ['投'], bats: '左', throws: '左', age: 29, trajectory: 1,
    contact: 14, power: 16, speed: 30, arm: 62, fielding: 54, catching: 52,
    pitching: { role: 'starter', velocity: 144, control: 72, stamina: 78, pitches: P(['changeup', 3], ['slider', 2], ['curve', 2]) },
    skills: ['対左打者○'],
    model: 'MLB 技巧派左腕先発タイプ（平均144km/h(89mph)・与四球率2.4・150回）' },
  { id: 'b12', name: '朝比奈 迅', number: 34, pos: '投', positions: ['投'], bats: '右', throws: '右', age: 26, trajectory: 1,
    contact: 12, power: 14, speed: 36, arm: 68, fielding: 50, catching: 50,
    pitching: { role: 'reliever', velocity: 153, control: 52, stamina: 37, pitches: P(['shoot', 2], ['slider', 3]) },
    skills: ['重い球'],
    model: 'NPB 剛腕セットアッパータイプ（平均153km/h・与四球率3.4・60回）' },
  { id: 'b13', name: '剣持 雷', number: 19, pos: '投', positions: ['投'], bats: '左', throws: '左', age: 30, trajectory: 1,
    contact: 10, power: 12, speed: 30, arm: 70, fielding: 50, catching: 50,
    pitching: { role: 'closer', velocity: 154, control: 62, stamina: 31, pitches: P(['slider', 3], ['fork', 3]) },
    skills: ['奪三振', '対ピンチ○'],
    model: 'MLB 左の守護神タイプ（平均96mph≒154km/h・奪三振率13・与四球率2.8・40セーブ級）' },
  { id: 'b14', name: '橘 涼介', number: 13, pos: '投', positions: ['投'], bats: '右', throws: '右', age: 32, trajectory: 1,
    contact: 10, power: 12, speed: 32, arm: 66, fielding: 56, catching: 54,
    pitching: { role: 'reliever', velocity: 148, control: 70, stamina: 36, pitches: P(['changeup', 3], ['slider', 2]) },
    skills: ['低め○', 'ケガしにくさ○'],
    model: 'NPB 鉄腕中継ぎタイプ（平均148km/h・与四球率2.3・65登板60回・ホールド30級）' },
  { id: 'b15', name: '小早川 楓', number: 28, pos: '投', positions: ['投'], bats: '左', throws: '左', age: 27, trajectory: 1,
    contact: 12, power: 12, speed: 34, arm: 62, fielding: 52, catching: 50,
    pitching: { role: 'reliever', velocity: 145, control: 60, stamina: 42, pitches: P(['curve', 3], ['fork', 2]) },
    skills: ['対左打者○'],
    model: 'MLB 左のミドルリリーフタイプ（平均90mph≒145km/h・与四球率3.0・60回）' },
  // 控え野手（代打の千早 b9 ＋ 代走・控え捕手・ユーティリティ2人）
  { id: 'b16', name: '韋駄 天馬', number: 50, pos: '左', positions: ['左', '中', '右', '二'], bats: '右', throws: '右', age: 23, trajectory: 1,
    contact: 48, power: 28, speed: 93, arm: 62, fielding: 68, catching: 64, pitching: null,
    skills: ['盗塁◎', '代走○'],
    model: 'MLB 代走要員タイプ（控え／スプリント速度リーグ最上位・代走で15盗塁・打率.230）' },
  { id: 'b17', name: '堀 慎之介', number: 27, pos: '捕', positions: ['捕'], bats: '左', throws: '右', age: 28, trajectory: 2,
    contact: 48, power: 44, speed: 36, arm: 70, fielding: 64, catching: 70, pitching: null,
    skills: ['キャッチャー○'],
    model: 'NPB 第2捕手タイプ（控え／打率.235・3本・盗塁阻止率.300前後）' },
  { id: 'b18', name: '真田 凌', number: 4, pos: '二', positions: ['二', '遊', '三', '一'], bats: '両', throws: '右', age: 30, trajectory: 2,
    contact: 60, power: 42, speed: 60, arm: 64, fielding: 70, catching: 72, pitching: null,
    skills: ['流し打ち', '守備職人'],
    model: 'MLB スーパーユーティリティタイプ（控え／打率.270・5本・内野全ポジション）' },
  { id: 'b19', name: '大河内 武', number: 33, pos: '一', positions: ['一', '三', '右'], bats: '左', throws: '右', age: 33, trajectory: 3,
    contact: 54, power: 62, speed: 38, arm: 60, fielding: 52, catching: 60, pitching: null,
    skills: ['代打○', 'パワーヒッター'],
    model: 'NPB 一塁・三塁兼用の控えベテランタイプ（打率.250・12本・代打要員）' },
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
];
