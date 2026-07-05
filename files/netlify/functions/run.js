// netlify/functions/run.js
// 웹페이지의 "지금 동기화" 버튼이 부르는 HTTP 함수.
// 실제 크롤링은 crawl.js 의 runCrawl() 을 재사용한다.
import { runCrawl } from "./crawl.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
};

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }
  try {
    const r = await runCrawl();
    return { statusCode: 200, headers: CORS, body: JSON.stringify(r) };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
