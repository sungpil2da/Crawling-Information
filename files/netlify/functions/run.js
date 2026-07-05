// netlify/functions/run.js
// 웹페이지 "지금 동기화" 버튼이 부르는 HTTP 함수 (독립 실행 — crawl.js 의존 없음)
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import crypto from "node:crypto";

const DEFAULT_SOURCES = {
  s1: { name: "서울신문",     cat: "뉴스", url: "https://www.seoul.co.kr/xml/rss/rss_society.xml", on: true },
  s2: { name: "SBS 지역",     cat: "뉴스", url: "https://news.sbs.co.kr/news/SectionRssFeed.do?sectionId=08", on: true },
  s3: { name: "경향 지역",    cat: "뉴스", url: "https://www.khan.co.kr/rss/rssdata/local_news.xml", on: true },
  s4: { name: "오마이뉴스",    cat: "뉴스", url: "http://rss.ohmynews.com/rss/ohmynews.xml", on: true },
  s5: { name: "경향 문화",    cat: "문화", url: "https://www.khan.co.kr/rss/rssdata/culture_news.xml", on: true },
  s6: { name: "SBS 문화연예",  cat: "문화", url: "https://news.sbs.co.kr/news/SectionRssFeed.do?sectionId=07", on: true },
  s7: { name: "서울신문 생활",  cat: "생활", url: "https://www.seoul.co.kr/xml/rss/rss_life.xml", on: true },
};
const KEYWORDS = ["서울", "강서", "마곡", "축제", "행사", "공지", "모집", "무료", "문화"];
const MAX_PER_SOURCE = 40;
const KEEP = 100;

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
function mergeFeed(existing, fresh, keep = KEEP, now = Date.now()) {
  const map = { ...existing };
  let added = 0;
  for (const it of fresh) {
    const id = hashId(it.link);
    if (!map[id]) { map[id] = { ...it, addedAt: now }; added++; }
  }
  const sortKey = (it) => Date.parse(it.date) || it.addedAt || 0;
  const trimmed = Object.entries(map).sort((a, b) => sortKey(b[1]) - sortKey(a[1])).slice(0, keep);
  return { next: Object.fromEntries(trimmed), added, total: trimmed.length };
}

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

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
};

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  try {
    const database = db();
    const srcRef = database.ref("sources");
    let srcObj = (await srcRef.once("value")).val();
    if (!srcObj) { await srcRef.set(DEFAULT_SOURCES); srcObj = DEFAULT_SOURCES; }
    const active = Object.values(srcObj).filter((s) => s && s.on && s.url);
    if (active.length === 0) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, added: 0, total: 0, msg: "켜진 출처가 없어요" }) };
    }

    const results = await Promise.allSettled(active.map(fetchSource));
    const fresh = [];
    results.forEach((r) => { if (r.status === "fulfilled") fresh.push(...r.value); });

    const feedRef = database.ref("feed");
    const cur = (await feedRef.once("value")).val() || {};
    const { next, added, total } = mergeFeed(cur, fresh);
    await feedRef.set(next);
    await database.ref("meta").update({ lastSync: Date.now(), lastCount: total });

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, sources: active.length, crawled: fresh.length, added, total }) };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
