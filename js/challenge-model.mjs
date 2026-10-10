// Timing is measured in seconds relative to the ball reaching home plate.
export function judgeSwing(offset, combo = 0) {
  const error = Math.abs(offset);
  const kind = error <= .11 ? 'hr' : error <= .23 ? 'hit' : 'miss';
  const nextCombo = kind === 'miss' ? 0 : combo + 1;
  return { kind, combo: nextCombo, points: kind === 'miss' ? 0 :
    (kind === 'hr' ? 300 : 100) + Math.min(5, nextCombo - 1) * 50,
    hint: kind !== 'miss' ? '' : offset < 0 ? 'もうすこし まってみよう' : 'つぎは すこし はやく！' };
}
export function pitchDuration(ball) { return [1.65, 1.65, 1.5, 1.8, 1.4][Math.floor(ball / 2) % 5]; }
