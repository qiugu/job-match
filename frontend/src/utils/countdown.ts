// 限流冷却倒计时的展示格式。
//
// 冷却跨度从几十秒（接口限流）到十几小时（每日额度次日重置）不等，因此
// 超过 1 小时补上小时位。用纯数字时钟而非「N 分钟」，中英文都能直接复用，
// 也免去单位文案的本地化。
/** 剩余秒数 → mm:ss；满 1 小时则为 h:mm:ss。 */
export function formatCountdown(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}
