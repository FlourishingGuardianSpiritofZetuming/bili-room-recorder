/**
 * 本地识别没有 B 站的“说话人”标注，只能靠麦位状态推断。
 * 规则（按可靠性排序）：
 *   1. 只有 1 个人开麦 → 就是他；
 *   2. 全部闭麦 → 明确标注（多半是音乐/环境音）；
 *   3. 多人开麦 → 不猜，标“麦上多人（N）”，附候选名单。
 */
export function resolveSpeaker(seats) {
  const list = (seats || []).filter((s) => s && s.uid);
  const unmuted = list.filter((s) => !s.mute);
  if (unmuted.length === 1) {
    return {
      uid: String(unmuted[0].uid),
      name: unmuted[0].name || `UID ${unmuted[0].uid}`,
      confidence: 'single',
      candidates: [unmuted[0].name],
    };
  }
  if (!unmuted.length) {
    return { uid: '', name: '麦上（全部闭麦）', confidence: 'none', candidates: [] };
  }
  return {
    uid: '',
    name: `麦上多人（${unmuted.length}）`,
    confidence: 'multi',
    candidates: unmuted.map((s) => s.name),
  };
}
