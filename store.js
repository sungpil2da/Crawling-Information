import { getStore } from '@netlify/blobs';

/**
 * 저장소는 4개 네임스페이스로 나눈다.
 *  config  : 키워드 규칙 (관리 화면에서 수정)
 *  seen    : 중복 발송 방지 마커
 *  secrets : 장기 액세스 토큰 (자동 갱신 대상)
 *  logs    : 최근 발송 기록
 */

/**
 * Netlify Blobs는 함수 런타임 밖에서는 동작하지 않는다.
 * 로컬 실행이나 `npm test`에서는 메모리로 대체해 그대로 굴러가게 한다.
 * 이때 저장된 값은 프로세스가 끝나면 사라진다.
 */
function memoryStore() {
  const m = new Map();
  return {
    async get(key, o) {
      const v = m.get(key);
      if (v === undefined) return null;
      return o?.type === 'json' ? JSON.parse(v) : v;
    },
    async setJSON(key, val) { m.set(key, JSON.stringify(val)); },
    async delete(key) { m.delete(key); },
  };
}

const OFFLINE = /blob|environment|siteID|site ID|token|context/i;
let warned = false;

const stores = new Map();

function ns(name) {
  if (stores.has(name)) return stores.get(name);

  let backend;
  try {
    backend = getStore({ name, consistency: 'strong' });
  } catch {
    backend = memoryStore();
  }

  // getStore()가 통과해도 첫 읽기/쓰기에서 환경 문제가 드러나는 경우가 있다.
  const run = async (method, ...args) => {
    try {
      return await backend[method](...args);
    } catch (err) {
      if (!OFFLINE.test(err?.message ?? '')) throw err;
      if (!warned) {
        warned = true;
        console.warn('Netlify Blobs를 쓸 수 없어 메모리 저장소로 대체합니다. 값은 유지되지 않습니다.');
      }
      backend = memoryStore();
      return backend[method](...args);
    }
  };

  const api = {
    get: (...a) => run('get', ...a),
    setJSON: (...a) => run('setJSON', ...a),
    delete: (...a) => run('delete', ...a),
  };
  stores.set(name, api);
  return api;
}

/* ---------------------------------- 규칙 ---------------------------------- */

export const DEFAULT_RULES = {
  comment: {
    enabled: true,
    alsoReplyPublicly: true,
    publicReplyText: 'DM 보내드렸어요, 확인해 주세요.',
    rules: [
      {
        id: 'guide',
        label: '자료 요청',
        keywords: ['자료', '가이드', 'guide', '링크'],
        message:
          '안녕하세요! 요청하신 자료 링크 보내드립니다.\nhttps://example.com/guide\n\n궁금한 점 있으시면 여기로 답장 주세요.',
      },
    ],
    fallback: null,
  },
  dm: {
    enabled: true,
    rules: [
      {
        id: 'price',
        label: '가격 문의',
        keywords: ['가격', '얼마', '비용', 'price'],
        message: '가격 문의 감사합니다. 기본 패키지는 30만원부터 시작합니다.\n자세한 견적은 어떤 작업이 필요하신지 알려주시면 안내드릴게요.',
      },
    ],
    fallback: {
      message: '메시지 감사합니다. 확인 후 빠르게 답변드리겠습니다.',
      cooldownHours: 24,
    },
  },
};

export async function loadRules() {
  const stored = await ns('config').get('rules', { type: 'json' });
  return stored ?? DEFAULT_RULES;
}

export async function saveRules(rules) {
  await ns('config').setJSON('rules', rules);
}

/* ------------------------------ 중복 발송 방지 ------------------------------ */

/**
 * 키를 선점한다. 처음 보는 키면 true, 이미 처리한 키면 false.
 * Meta도 댓글당 1회만 허용하지만, 웹훅 재시도로 인한 이중 발송을 미리 막는다.
 */
export async function claim(key, ttlHours = 24 * 30) {
  const store = ns('seen');
  const existing = await store.get(key, { type: 'json' });
  if (existing && Date.now() - existing.at < ttlHours * 3600_000) return false;
  await store.setJSON(key, { at: Date.now() });
  return true;
}

/* ------------------------------ 시간당 발송량 ------------------------------ */

/**
 * Meta는 계정당 시간당 750건까지 private reply를 허용한다.
 * 한도를 넘기면 code 368로 계정이 24~48시간 정지되므로 기본값은 여유를 둔 700이다.
 */
export async function takeQuota() {
  const cap = Number(process.env.IG_HOURLY_CAP || 700);
  const bucket = `q:${new Date().toISOString().slice(0, 13)}`; // 시간 단위 버킷
  const store = ns('seen');
  const used = (await store.get(bucket, { type: 'json' }))?.n ?? 0;
  if (used >= cap) return false;
  await store.setJSON(bucket, { n: used + 1, at: Date.now() });
  return true;
}

/** 일시적 실패(네트워크 끊김 등) 뒤 Meta 재시도가 통하도록 선점을 되돌린다. */
export async function release(key) {
  await ns('seen').delete(key).catch(() => {});
}

/* --------------------------------- 토큰 --------------------------------- */

export async function getToken() {
  const stored = await ns('secrets').get('ig_token', { type: 'json' });
  if (stored?.value) return stored;
  // 최초 실행: 환경변수의 장기 토큰을 저장소로 옮긴다.
  const seed = process.env.IG_ACCESS_TOKEN;
  if (!seed) throw new Error('IG_ACCESS_TOKEN 환경변수가 없습니다.');
  const record = { value: seed, refreshedAt: Date.now() };
  await ns('secrets').setJSON('ig_token', record);
  return record;
}

export async function setToken(value) {
  await ns('secrets').setJSON('ig_token', { value, refreshedAt: Date.now() });
}

/* --------------------------------- 로그 --------------------------------- */

export async function appendLog(entry) {
  const store = ns('logs');
  const current = (await store.get('recent', { type: 'json' })) ?? [];
  current.unshift({ ...entry, at: Date.now() });
  await store.setJSON('recent', current.slice(0, 100));
}

export async function readLogs() {
  return (await ns('logs').get('recent', { type: 'json' })) ?? [];
}
