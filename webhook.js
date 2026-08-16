import { loadRules, claim, release, takeQuota, appendLog } from '../../lib/store.js';
import { sendPrivateReply, sendDirectMessage, replyToComment } from '../../lib/ig.js';
import { verifySignature, findRule, withinPrivateReplyWindow } from '../../lib/match.js';

export const config = { path: '/webhook' };

export default async (req) => {
  if (req.method === 'GET') return handleVerification(req);
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const raw = await req.text();

  if (!verifySignature(raw, req.headers.get('x-hub-signature-256'))) {
    return new Response('Invalid signature', { status: 401 });
  }

  // Meta는 몇 초 안에 200을 못 받으면 같은 이벤트를 재시도한다.
  // 처리 중 어떤 예외가 나든 200을 돌려주고, 실패는 로그로만 남긴다.
  try {
    const payload = JSON.parse(raw);
    if (payload.object === 'instagram') {
      const rules = await loadRules();
      for (const entry of payload.entry ?? []) {
        for (const change of entry.changes ?? []) {
          if (change.field === 'comments') await onComment(change.value, rules, entry.time);
        }
        for (const event of entry.messaging ?? []) {
          await onMessage(event, rules);
        }
      }
    }
  } catch (err) {
    console.error('webhook 처리 실패:', err);
  }

  return new Response('EVENT_RECEIVED', { status: 200 });
};

/* --------------------------- 웹훅 URL 등록 검증 --------------------------- */

function handleVerification(req) {
  const q = new URL(req.url).searchParams;
  const ok =
    q.get('hub.mode') === 'subscribe' &&
    q.get('hub.verify_token') === process.env.IG_VERIFY_TOKEN;

  return ok
    ? new Response(q.get('hub.challenge'), {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    : new Response('Verification failed', { status: 403 });
}

/* -------------------------------- 댓글 처리 -------------------------------- */

async function onComment(value, rules, eventTime) {
  const cfg = rules.comment;
  const commentId = value?.id;
  const text = value?.text ?? '';
  const author = value?.from?.id;

  if (!cfg?.enabled || !commentId) return;

  // 내가 단 댓글에 내가 답장하는 무한 루프를 막는다.
  if (author && author === process.env.IG_USER_ID) return;

  if (!withinPrivateReplyWindow(value?.timestamp ?? eventTime)) {
    return log('comment', 'skipped', { commentId, reason: '7일 창 만료' });
  }

  const rule = findRule(cfg.rules, text) ?? cfg.fallback;
  if (!rule) return;

  // 웹훅 재시도로 같은 댓글에 두 번 보내지 않도록 선점한다.
  if (!(await claim(`c:${commentId}`))) return;

  // 게시물이 터졌을 때 Meta의 시간당 상한을 넘기면 계정이 정지된다.
  // 한도에 닿으면 발송을 포기하되 선점은 풀어, 다음 시간에 재시도가 가능하게 한다.
  if (!(await takeQuota())) {
    await release(`c:${commentId}`);
    return log('comment', 'skipped', { commentId, reason: '시간당 발송 한도 도달' });
  }

  try {
    await sendPrivateReply(commentId, rule.message);
    await log('comment', 'sent', { commentId, rule: rule.id, username: value?.from?.username });

    if (cfg.alsoReplyPublicly && cfg.publicReplyText) {
      // 공개 답글은 별도 API라 private reply 할당량을 쓰지 않는다.
      await replyToComment(commentId, cfg.publicReplyText).catch((e) =>
        console.warn('공개 답글 실패:', e.message)
      );
    }
  } catch (err) {
    // err.code가 없으면 Meta가 거절한 게 아니라 네트워크 문제다.
    // 이 경우 선점을 풀어 Meta의 재시도가 통하게 한다.
    if (!err.code) await release(`c:${commentId}`);
    await log('comment', 'failed', { commentId, error: err.message, code: err.code });
  }
}

/* --------------------------------- DM 처리 --------------------------------- */

async function onMessage(event, rules) {
  const cfg = rules.dm;
  const msg = event?.message;
  const sender = event?.sender?.id;

  if (!cfg?.enabled || !msg || !sender) return;

  // is_echo는 내가 보낸 메시지가 되돌아온 것이다. 여기 반응하면 자기 자신과 대화하게 된다.
  if (msg.is_echo) return;
  if (sender === process.env.IG_USER_ID) return;

  const text = msg.text ?? '';
  if (!text) return; // 사진/스티커만 온 경우는 사람이 처리하도록 남겨둔다

  if (!(await claim(`m:${msg.mid}`, 24))) return;

  const rule = findRule(cfg.rules, text);

  if (rule) {
    await deliver(sender, rule.message, rule.id);
    return;
  }

  // 맞는 키워드가 없을 때만 기본 응답을 보낸다.
  // 같은 사람에게 계속 같은 안내가 가지 않도록 쿨다운을 둔다.
  const fb = cfg.fallback;
  if (!fb?.message) return;
  if (!(await claim(`fb:${sender}`, fb.cooldownHours ?? 24))) return;

  await deliver(sender, fb.message, 'fallback');
}

async function deliver(igsid, text, ruleId) {
  try {
    await sendDirectMessage(igsid, text);
    await log('dm', 'sent', { igsid, rule: ruleId });
  } catch (err) {
    await log('dm', 'failed', { igsid, rule: ruleId, error: err.message, code: err.code });
  }
}

const log = (source, status, detail) =>
  appendLog({ source, status, ...detail }).catch(() => {});
