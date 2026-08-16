import { normalize, findRule, verifySignature, withinPrivateReplyWindow } from '../lib/match.js';
import crypto from 'node:crypto';

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? (pass++, console.log('  ✓', name)) : (fail++, console.log('  ✗', name)); };

console.log('normalize');
ok('대소문자/공백 제거', normalize('  Guide  ') === 'guide');
ok('문장부호 제거', normalize('자료!!!') === '자료');
ok('이모지 제거', normalize('자료 📩 주세요') === '자료주세요');
ok('한글 자모 정규화(NFKC)', normalize('ﾊ') === 'ハ');

console.log('findRule');
const rules = [
  { id: 'guide', keywords: ['자료', 'guide'], message: 'A' },
  { id: 'price', keywords: ['가격', '얼마'], message: 'B' },
];
ok('한글 부분일치', findRule(rules, '자료 좀 보내주세요')?.id === 'guide');
ok('영문 대소문자 무시', findRule(rules, 'Send me the GUIDE plz')?.id === 'guide');
ok('공백 낀 키워드도 매칭', findRule(rules, '가 격 알려주세요')?.id === 'price');
ok('두번째 규칙', findRule(rules, '얼마에요?')?.id === 'price');
ok('무매칭은 null', findRule(rules, '잘 봤습니다') === null);
ok('빈 문자열은 null', findRule(rules, '   ') === null);
ok('빈 규칙목록 안전', findRule([], '자료') === null);

console.log('verifySignature');
process.env.IG_APP_SECRET = 'testsecret';
const body = JSON.stringify({ object: 'instagram', entry: [] });
const sig = 'sha256=' + crypto.createHmac('sha256', 'testsecret').update(body).digest('hex');
ok('올바른 서명 통과', verifySignature(body, sig) === true);
ok('변조된 본문 거부', verifySignature(body + 'x', sig) === false);
ok('잘못된 시크릿 거부', verifySignature(body, 'sha256=' + 'a'.repeat(64)) === false);
ok('헤더 없으면 거부', verifySignature(body, null) === false);
ok('길이 다른 서명도 예외 없이 거부', verifySignature(body, 'sha256=abc') === false);

console.log('7일 창');
const iso = (d) => new Date(Date.now() - d * 86400_000).toISOString();
ok('1일 전 댓글 통과', withinPrivateReplyWindow(iso(1)) === true);
ok('8일 전 댓글 차단', withinPrivateReplyWindow(iso(8)) === false);
ok('시각 없으면 통과', withinPrivateReplyWindow(undefined) === true);

console.log(`\n${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
