import { getToken, setToken } from './store.js';

const VERSION = process.env.IG_GRAPH_VERSION || 'v23.0';
const BASE = `https://graph.instagram.com/${VERSION}`;

/** Meta가 돌려주는 에러 코드 중 실제로 자주 마주치는 것들 */
const ERROR_HINTS = {
  10: '24시간 메시지 창을 벗어났습니다. 상대가 다시 메시지를 보내야 발송할 수 있습니다.',
  100: '요청이 거부됐습니다. 댓글이 7일을 넘었거나, 이미 답장했거나, 상대 계정이 메시지 요청을 차단한 상태일 수 있습니다.',
  190: '액세스 토큰이 만료됐습니다. 계정을 다시 연결해야 합니다.',
  368: '발송 속도 제한에 걸렸습니다. 24~48시간 멈춘 뒤 더 느린 속도로 재개하세요.',
  508: '이 계정은 링크 공유가 제한돼 있습니다. 메시지에서 URL을 빼고 시도하세요.',
};

async function call(path, { method = 'POST', body, query } = {}) {
  const { value: token } = await getToken();
  const url = new URL(`${BASE}${path}`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data.error ?? {};
    const hint = ERROR_HINTS[err.code];
    const e = new Error(hint ? `${err.message} — ${hint}` : err.message || `HTTP ${res.status}`);
    e.code = err.code;
    e.subcode = err.error_subcode;
    throw e;
  }
  return data;
}

const igUserId = () => process.env.IG_USER_ID;

/**
 * 댓글 작성자에게 DM을 보낸다 (private reply).
 * 댓글 작성 시각으로부터 7일 이내, 댓글당 정확히 한 번만 가능하다.
 */
export function sendPrivateReply(commentId, text) {
  return call(`/${igUserId()}/messages`, {
    body: { recipient: { comment_id: commentId }, message: { text } },
  });
}

/**
 * DM을 보낸 사람에게 답장한다.
 * 상대의 마지막 메시지로부터 24시간 이내에만 자유 형식 발송이 가능하다.
 */
export function sendDirectMessage(igsid, text) {
  return call(`/${igUserId()}/messages`, {
    body: { recipient: { id: igsid }, message: { text } },
  });
}

/**
 * 댓글에 공개 답글을 단다. private reply 할당량과는 별개다.
 */
export function replyToComment(commentId, text) {
  return call(`/${commentId}/replies`, { body: { message: text } });
}

/**
 * 60일짜리 장기 토큰을 갱신한다. 만료 전 최소 한 번은 호출돼야 한다.
 */
export async function refreshAccessToken() {
  const { value: token } = await getToken();
  const url = new URL('https://graph.instagram.com/refresh_access_token');
  url.searchParams.set('grant_type', 'ig_refresh_token');
  url.searchParams.set('access_token', token);

  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || '토큰 갱신 실패');

  await setToken(data.access_token);
  return { expiresInDays: Math.round((data.expires_in ?? 0) / 86400) };
}
