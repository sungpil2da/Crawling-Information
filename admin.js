import { loadRules, saveRules, readLogs, DEFAULT_RULES } from '../../lib/store.js';

export const config = { path: '/api/admin/*' };

/**
 * 관리 화면이 쓰는 API. 규칙 읽기/쓰기와 최근 발송 기록 조회만 한다.
 * 브라우저에 노출되는 엔드포인트이므로 토큰 없이는 아무것도 돌려주지 않는다.
 */
export default async (req) => {
  if (!authorized(req)) return json({ error: '인증 토큰이 올바르지 않습니다.' }, 401);

  const path = new URL(req.url).pathname.replace('/api/admin/', '');

  try {
    if (path === 'rules' && req.method === 'GET') {
      return json({ rules: await loadRules() });
    }
    if (path === 'rules' && req.method === 'PUT') {
      const rules = await req.json();
      const problem = validate(rules);
      if (problem) return json({ error: problem }, 400);
      await saveRules(rules);
      return json({ rules });
    }
    if (path === 'rules/reset' && req.method === 'POST') {
      await saveRules(DEFAULT_RULES);
      return json({ rules: DEFAULT_RULES });
    }
    if (path === 'logs' && req.method === 'GET') {
      return json({ logs: await readLogs() });
    }
  } catch (err) {
    return json({ error: err.message }, 500);
  }

  return json({ error: '없는 경로입니다.' }, 404);
};

function authorized(req) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  const header = req.headers.get('authorization') ?? '';
  return header === `Bearer ${expected}`;
}

function validate(rules) {
  for (const section of ['comment', 'dm']) {
    const list = rules?.[section]?.rules;
    if (!Array.isArray(list)) return `${section} 규칙 목록이 배열이 아닙니다.`;
    for (const r of list) {
      if (!r.message?.trim()) return `"${r.label || r.id}" 규칙에 보낼 메시지가 비어 있습니다.`;
      if (!Array.isArray(r.keywords) || r.keywords.length === 0)
        return `"${r.label || r.id}" 규칙에 키워드가 없습니다.`;
    }
  }
  return null;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
