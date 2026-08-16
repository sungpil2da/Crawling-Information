/**
 * 배포 전 자체 점검. 실제 Meta API 대신 가짜 fetch를 물려 동작만 확인한다.
 *   node test/webhook.test.mjs
 */
import crypto from 'node:crypto';

process.env.IG_APP_SECRET = 'test-secret';
process.env.IG_USER_ID = '17841400000000000';
process.env.IG_VERIFY_TOKEN = 'verify-me';
process.env.IG_ACCESS_TOKEN = 'seed-token';

const { default: webhook } = await import('../netlify/functions/webhook.js');
const { readLogs } = await import('../lib/store.js');

/* ----------------------------- 가짜 Graph API ----------------------------- */

let calls = [];
globalThis.fetch = async (url, opts = {}) => {
  calls.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : null });
  return { ok: true, status: 200, json: async () => ({ message_id: 'mid.fake' }) };
};

/* -------------------------------- 도우미 -------------------------------- */

const sign = (raw) =>
  'sha256=' + crypto.createHmac('sha256', process.env.IG_APP_SECRET).update(raw, 'utf8').digest('hex');

function post(payload, { badSig = false } = {}) {
  const raw = JSON.stringify(payload);
  return webhook(
    new Request('https://x.test/webhook', {
      method: 'POST',
      headers: { 'x-hub-signature-256': badSig ? 'sha256=dead' : sign(raw) },
      body: raw,
    })
  );
}

const secs = (d) => Math.floor((Date.now() - d * 86400_000) / 1000);

const comment = (id, text, time = secs(0)) => ({
  object: 'instagram',
  entry: [{ id: process.env.IG_USER_ID, time, changes: [{ field: 'comments', value: { id, text, from: { id: '999', username: 'tester' } } }] }],
});

const dm = (mid, text, sender = '555', extra = {}) => ({
  object: 'instagram',
  entry: [{ id: process.env.IG_USER_ID, time: secs(0), messaging: [{ sender: { id: sender }, recipient: { id: process.env.IG_USER_ID }, message: { mid, text, ...extra } }] }],
});

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}
const sent = () => calls.filter((c) => c.url.includes('/messages'));
const reset = () => { calls = []; };

/* --------------------------------- 검증 --------------------------------- */

console.log('\n웹훅 등록 검증');
{
  const ok = await webhook(new Request('https://x.test/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=CH123'));
  check('올바른 토큰이면 challenge를 그대로 돌려준다', await ok.text() === 'CH123');
  const bad = await webhook(new Request('https://x.test/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=CH123'));
  check('틀린 토큰은 403', bad.status === 403);
}

console.log('\n서명 검증');
{
  reset();
  const res = await post(comment('c_sig', '자료 주세요'), { badSig: true });
  check('서명이 틀리면 401', res.status === 401);
  check('서명이 틀리면 DM을 보내지 않는다', sent().length === 0);
}

console.log('\n시간당 한도');
{
  // 이 블록은 다른 댓글 테스트보다 먼저 돌아야 한다.
  // 시간 버킷은 모듈 전체가 공유하므로, 앞에서 발송이 일어나면 카운터가 이미 차 있다.
  process.env.IG_HOURLY_CAP = '2';
  reset();
  for (const id of ['q_a', 'q_b', 'q_c']) await post(comment(id, '자료'));
  check('한도 2건을 넘기면 발송을 멈춘다', sent().length === 2, `보낸 수=${sent().length}`);
  delete process.env.IG_HOURLY_CAP;
}

console.log('\n댓글 → DM');
{
  reset();
  const res = await post(comment('c_1', '자료 부탁드려요!!'));
  check('200을 돌려준다', res.status === 200);
  check('private reply를 1건 보낸다', sent().length === 1, JSON.stringify(sent()));
  check('recipient가 comment_id다', sent()[0]?.body?.recipient?.comment_id === 'c_1');
  check('공개 답글도 남긴다', calls.some((c) => c.url.includes('/c_1/replies')));

  reset();
  await post(comment('c_1', '자료 부탁드려요!!'));
  check('같은 댓글 재시도는 다시 보내지 않는다', sent().length === 0);

  reset();
  await post(comment('c_2', '잘 봤습니다'));
  check('키워드가 없으면 보내지 않는다', sent().length === 0);

  reset();
  await post(comment('c_3', '자료 주세요', secs(8)));
  check('8일 지난 댓글은 건너뛴다', sent().length === 0);

  reset();
  await post(comment('c_4', '가이드 있나요'));
  check('다른 키워드도 같은 규칙에 걸린다', sent().length === 1);
}

console.log('\n받은 DM → 답장');
{
  reset();
  await post(dm('m_1', '가격 얼마인가요?'));
  check('키워드 규칙이 발동한다', sent().length === 1);
  check('recipient가 발신자 IGSID다', sent()[0]?.body?.recipient?.id === '555');

  reset();
  await post(dm('m_1', '가격 얼마인가요?'));
  check('같은 mid 재시도는 무시한다', sent().length === 0);

  reset();
  await post(dm('m_2', '내가 보낸 메시지', '555', { is_echo: true }));
  check('is_echo는 무시한다 (자기 자신과 대화 방지)', sent().length === 0);

  reset();
  await post(dm('m_3', '안녕하세요', '777'));
  check('키워드가 없으면 기본 응답을 보낸다', sent().length === 1);

  reset();
  await post(dm('m_4', '또 인사', '777'));
  check('같은 사람에게 기본 응답을 반복하지 않는다 (쿨다운)', sent().length === 0);

  reset();
  await post(dm('m_5', '안녕하세요', '888'));
  check('다른 사람에게는 기본 응답이 나간다', sent().length === 1);
}

console.log('\n기록');
{
  const logs = await readLogs();
  check('발송 기록이 남는다', logs.some((l) => l.status === 'sent'));
  check('건너뛴 사유도 남는다', logs.some((l) => l.status === 'skipped'));
}

console.log(`\n통과 ${pass} / 실패 ${fail}\n`);
process.exit(fail ? 1 : 0);
