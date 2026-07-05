// netlify/functions/crawl.js
// 서울 동네 생활정보 크롤러 (스케줄 실행 → Firebase Realtime DB에 저장)
// - 브라우저 대신 이 함수가 RSS를 긁고(=CORS 없음)
// - 새 글만 Firebase 에 저장 → HTML 은 Firebase 를 실시간 구독만 하면 됨
// 스케줄: 아래 config.schedule (기본 30분마다). 첫 실행은 CLI 로 수동 트리거.

import admin from "firebase-admin";
import crypto from "node:crypto";

// ===== 설정: 여기만 바꾸면 됨 =====
const SOURCES = [
  { name: "서울신문",   url: "https://www.seoul.co.kr/xml/rss/rss_society.xml" },
  { name: "SBS 지역",  url: "https://news.sbs.co.kr/news/SectionRssFeed.do?sectionId=08" },
  { name: "경향 지역", url: "https://www.khan.co.kr/rss/rssdata/local_news.xml" },
  { name: "오마이뉴스", url: "http://rss.ohmynews.com/rss/ohmynews.xml" },
];
// 서울 동네 키워드 (제목/요약에 하나라도 있어야 통과). 전부 받으려면 [] 로.
const KEYWORDS = ["서울", "강서", "마곡", "축제", "행사", "공지", "모집", "무료", "문화"];

const MAX_PER_SOURCE = 40;
const KEEP = 100; // Firebase 에 최근 몇 개까지 보관할지

// ===== RSS 파싱 (외부 라이브러리 없이) =====
const decode = (s) =>
  (s || "")
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim();

const pick = (block, tag) => {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(block);
  return m ? decode(m[1]) : "";
};
const matchKeyword = (t) => KEYWORDS.length === 0 || KEYWORDS.some((k) => t.includes(k));
const hashId = (link) => crypto.createHash("md5").update(link).digest("hex");

async function fetchSource(src) {
  const res = await fetch(src.url, { headers: { "User-Agent": "DongnaeInfoBot/1.0" } });
  const xml = await res.text();
  const blocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, MAX_PER_SOURCE);
  const items = [];
  for (const m of blocks) {
    const b = m[1];
    const title = pick(b, "title");
    const link = pick(b, "link");
    if (!title || !link) continue;
    const summary = pick(b, "description").slice(0, 180);
    const date = pick(b, "pubDate") || pick(b, "dc:date") || "";
    if (!matchKeyword(title + " " + summary)) continue;
    items.push({ source: src.name, title, link, summary, date });
  }
  return items;
}

// ===== 순수 병합 로직 (테스트 가능) =====
// existing: {id: item} , fresh: [item] → 새 글 추가 + 최신순 KEEP개 유지
export function mergeFeed(existing, fresh, keep = KEEP, now = Date.now()) {
  const map = { ...existing };
  let added = 0;
  for (const it of fresh) {
    const id = hashId(it.link);
    if (!map[id]) {
      map[id] = { ...it, addedAt: now };
      added++;
    }
  }
  const trimmed = Object.entries(map)
    .sort((a, b) => sortKey(b[1]) - sortKey(a[1]))
    .slice(0, keep);
  return { next: Object.fromEntries(trimmed), added, total: trimmed.length };
}
const sortKey = (it) => Date.parse(it.date) || it.addedAt || 0;

// ===== Firebase =====
let _app;
function db() {
  if (!_app) {
    _app = admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
      databaseURL: process.env.FIREBASE_DB_URL,
    });
  }
  return admin.database(_app);
}

export const handler = async () => {
  try {
    const results = await Promise.allSettled(SOURCES.map(fetchSource));
    const fresh = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") fresh.push(...r.value);
      else console.error(`${SOURCES[i].name} 실패:`, r.reason?.message);
    });

    const ref = db().ref("feed");
    const snap = await ref.once("value");
    const { next, added, total } = mergeFeed(snap.val() || {}, fresh);
    await ref.set(next);

    const msg = `crawled ${fresh.length}, added ${added}, total ${total}`;
    console.log(msg);
    return { statusCode: 200, body: msg };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: e.message };
  }
};

// 30분마다 자동 실행 (Netlify Scheduled Functions, UTC 기준)
export const config = { schedule: "*/30 * * * *" };
