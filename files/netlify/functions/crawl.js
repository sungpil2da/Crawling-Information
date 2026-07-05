// netlify/functions/crawl.js
// 서울 동네 생활정보 크롤러 (스케줄 실행 → Firebase Realtime DB에 저장)
// - 브라우저 대신 이 함수가 RSS를 긁고(=CORS 없음)
// - 새 글만 Firebase 에 저장 → HTML 은 Firebase 를 실시간 구독만 하면 됨
// 스케줄: 아래 config.schedule (기본 30분마다). 첫 실행은 CLI 로 수동 트리거.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import crypto from "node:crypto";

// ===== 설정: 여기만 바꾸면 됨 =====
// 기본 출처 목록(시드). Firebase 의 sources 가 비어있을 때 최초 1회 이 값이 저장됨.
// 이후에는 웹 "출처 관리"에서 켜고/끄고/추가/삭제한 값이 우선.
const DEFAULT_SOURCES = {
  s1: { name: "서울신문",     cat: "뉴스", url: "https://www.seoul.co.kr/xml/rss/rss_society.xml", on: true },
  s2: { name: "SBS 지역",     cat: "뉴스", url: "https://news.sbs.co.kr/news/SectionRssFeed.do?sectionId=08", on: true },
  s3: { name: "경향 지역",    cat: "뉴스", url: "https://www.khan.co.kr/rss/rssdata/local_news.xml", on: true },
  s4: { name: "오마이뉴스",    cat: "뉴스", url: "http://rss.ohmynews.com/rss/ohmynews.xml", on: true },
  s5: { name: "경향 문화",    cat: "문화", url: "https://www.khan.co.kr/rss/rssdata/culture_news.xml", on: true },
  s6: { name: "SBS 문화연예",  cat: "문화", url: "https://news.sbs.co.kr/news/SectionRssFeed.do?sectionId=07", on: true },
  s7: { name: "서울신문 생활",  cat: "생활", url: "https://www.seoul.co.kr/xml/rss/rss_life.xml", on: true },
};
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
    items.push({ source: src.name, cat: src.cat || "기타", title, link, summary, date });
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
    _app = getApps().length
      ? getApps()[0]
      : initializeApp({
          credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
          databaseURL: process.env.FIREBASE_DB_URL,
        });
  }
  return getDatabase(_app);
}

// Firebase 에서 출처 목록을 읽어옴. 없으면 기본값으로 시드.
async function loadSources(database) {
  const ref = database.ref("sources");
  const snap = await ref.once("value");
  let obj = snap.val();
  if (!obj) {                       // 최초 실행: 기본 목록 저장
    await ref.set(DEFAULT_SOURCES);
    obj = DEFAULT_SOURCES;
  }
  // on:true 인 것만, URL 있는 것만
  return Object.values(obj).filter((s) => s && s.on && s.url);
}

// 실제 크롤링 로직 (스케줄 함수와 버튼용 run 함수가 공유)
export async function runCrawl() {
  const database = db();
  const active = await loadSources(database);
  if (active.length === 0) {
    return { ok: true, msg: "켜진 출처가 없어요 (모두 꺼짐)", added: 0, total: 0 };
  }

  const results = await Promise.allSettled(active.map(fetchSource));
  const fresh = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") fresh.push(...r.value);
    else console.error(`${active[i].name} 실패:`, r.reason?.message);
  });

  const ref = database.ref("feed");
  const snap = await ref.once("value");
  const { next, added, total } = mergeFeed(snap.val() || {}, fresh);
  await ref.set(next);
  await database.ref("meta").update({ lastSync: Date.now(), lastCount: total });

  return { ok: true, sources: active.length, crawled: fresh.length, added, total,
           msg: `sources ${active.length}, crawled ${fresh.length}, added ${added}, total ${total}` };
}

export const handler = async () => {
  try {
    const r = await runCrawl();
    console.log(r.msg);
    return { statusCode: 200, body: r.msg };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: e.message };
  }
};

// 30분마다 자동 실행 (Netlify Scheduled Functions, UTC 기준)
export const config = { schedule: "*/30 * * * *" };
