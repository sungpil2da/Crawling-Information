import crypto from 'node:crypto';

/**
 * X-Hub-Signature-256 헤더를 앱 시크릿으로 검증한다.
 * 이걸 건너뛰면 누구나 웹훅 URL로 가짜 이벤트를 던져 DM을 발송시킬 수 있다.
 */
export function verifySignature(rawBody, header) {
  const secret = process.env.IG_APP_SECRET;
  if (!secret) throw new Error('IG_APP_SECRET 환경변수가 없습니다.');
  if (!header?.startsWith('sha256=')) return false;

  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const received = header.slice(7);
  if (expected.length !== received.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

/**
 * 매칭 전에 텍스트를 정규화한다.
 * 공백, 문장부호, 이모지, 대소문자 차이로 규칙이 빗나가는 걸 막는다.
 */
export function normalize(text = '') {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\p{P}\p{S}\p{Emoji_Presentation}]/gu, '')
    .replace(/\s+/g, '');
}

/**
 * 규칙 목록에서 첫 번째로 맞는 규칙을 찾는다.
 * 위에 있는 규칙이 우선하므로, 좁은 조건을 위쪽에 두는 게 맞다.
 */
export function findRule(rules = [], text) {
  const haystack = normalize(text);
  if (!haystack) return null;
  return (
    rules.find((rule) =>
      (rule.keywords ?? []).some((kw) => {
        const needle = normalize(kw);
        return needle && haystack.includes(needle);
      })
    ) ?? null
  );
}

/**
 * 댓글 작성 시각 기준 7일 창이 아직 열려 있는지 확인한다.
 * Meta는 웹훅을 받은 시각이 아니라 댓글이 달린 시각부터 7일을 센다.
 * 유닉스 초와 ISO 문자열을 모두 받는다.
 */
export function withinPrivateReplyWindow(when) {
  if (!when) return true; // 시각 정보가 없으면 API 판단에 맡긴다
  const ms = typeof when === 'number' ? when * 1000 : new Date(when).getTime();
  if (Number.isNaN(ms)) return true;
  return Date.now() - ms < 7 * 24 * 3600_000;
}
