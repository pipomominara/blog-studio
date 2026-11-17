// 네이버 공식 API로 키워드의 실제 검색 데이터를 가져온다
//  · 검색어트렌드 (필수): 최근 8주 검색 추이 → 상승세·상대 검색량
//      환경변수 NAVER_CLIENT_ID, NAVER_CLIENT_SECRET
//      신규: 네이버 클라우드 플랫폼 NAVER API HUB 애플리케이션 ('검색어 트렌드' API) / 기존: developers.naver.com 데이터랩 키
//  · 검색광고 키워드도구 (선택): 월간 검색수(PC+모바일) 절대값 + 연관 키워드
//      환경변수 NAVER_AD_API_KEY, NAVER_AD_SECRET, NAVER_AD_CUSTOMER_ID (searchad.naver.com → 도구 → API 사용 관리)
import crypto from "node:crypto";

const env = (k) => String(process.env[k] || "").trim().replace(/^["']+|["']+$/g, "").trim();
export const naverStatus = () => ({
  datalab: !!(env("NAVER_CLIENT_ID") && env("NAVER_CLIENT_SECRET")),
  searchad: !!(env("NAVER_AD_API_KEY") && env("NAVER_AD_SECRET") && env("NAVER_AD_CUSTOMER_ID")),
});

const key = (s) => String(s || "").toLowerCase().replace(/\s+/g, "");
const uniq = (arr) => { const seen = new Set(); return arr.map((s) => String(s || "").trim()).filter((s) => s && !seen.has(key(s)) && seen.add(key(s))); };
const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const kstDate = (offsetDays) => new Date(Date.now() + 9 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);

// ---------- 데이터랩 검색어트렌드 ----------
// 2026-07-31부터 신규 발급은 NAVER API HUB(네이버 클라우드 플랫폼)로 옮겨졌다. 기존 개발자센터 키도 전환 기간 동안 동작한다.
// 두 곳의 키는 서로 바꿔 쓸 수 없으므로, HUB로 먼저 부르고 인증이 안 되면 기존 개발자센터 주소로 한 번 더 시도한다.
const ENDPOINTS = {
  hub: { url: "https://naverapihub.apigw.ntruss.com/search-trend/v1/search", id: "X-NCP-APIGW-API-KEY-ID", secret: "X-NCP-APIGW-API-KEY" },
  legacy: { url: "https://openapi.naver.com/v1/datalab/search", id: "X-Naver-Client-Id", secret: "X-Naver-Client-Secret" },
};
let workingEndpoint = null;
async function datalabAt(ep, body) {
  return fetch(ep.url, { method: "POST", headers: { [ep.id]: env("NAVER_CLIENT_ID"), [ep.secret]: env("NAVER_CLIENT_SECRET"), "content-type": "application/json" }, body });
}
async function datalab(keywords, startDate, endDate) {
  const body = JSON.stringify({ startDate, endDate, timeUnit: "date", keywordGroups: keywords.map((k) => ({ groupName: k, keywords: [k] })) });
  const forced = env("NAVER_DATALAB_SOURCE").toLowerCase(); // "hub" 또는 "legacy"로 고정할 수 있다
  const order = workingEndpoint ? [workingEndpoint] : forced === "legacy" ? ["legacy"] : forced === "hub" ? ["hub"] : ["hub", "legacy"];
  let res, t = "";
  for (const name of order) {
    res = await datalabAt(ENDPOINTS[name], body);
    if (res.ok) { workingEndpoint = name; break; }
    t = await res.text().catch(() => "");
    if (![401, 403, 404].includes(res.status)) break; // 인증·주소 문제일 때만 다른 곳으로 재시도
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error(`네이버 검색어트렌드 인증 실패 (${res.status}) — NAVER_CLIENT_ID·NAVER_CLIENT_SECRET 값과, 애플리케이션에 '검색어 트렌드' API가 선택되어 있는지 확인해 주세요`);
    if (res.status === 429) throw new Error("네이버 검색어트렌드 하루 호출 한도를 넘었습니다. 내일 다시 시도해 주세요");
    throw new Error(`네이버 검색어트렌드 오류 (${res.status}): ${t.slice(0, 160)}`);
  }
  const j = await res.json();
  return (j.results || []).map((r) => ({ keyword: r.title, data: new Map((r.data || []).map((d) => [d.period, +d.ratio || 0])) }));
}

// 여러 번 나눠 조회해도 서로 비교할 수 있게, 매 조회에 같은 기준 키워드(anchor)를 넣어 비율을 맞춘다
export async function trendOf(keywords, { days = 56, recentDays = 14 } = {}) {
  const list = uniq(keywords).slice(0, 25);
  if (!list.length) return [];
  const endDate = kstDate(-1), startDate = kstDate(-days);
  const dates = Array.from({ length: days }, (_, i) => kstDate(-days + i));
  const series = new Map();
  const first = await datalab(list.slice(0, 5), startDate, endDate);
  first.forEach((r) => series.set(r.keyword, dates.map((d) => r.data.get(d) || 0)));
  const anchor = first.slice().sort((a, b) => mean([...b.data.values()]) - mean([...a.data.values()]))[0]?.keyword || list[0];
  const anchorBase = mean(series.get(anchor) || []);
  for (const part of chunks(list.slice(5), 4)) {
    await sleep(120);
    const rs = await datalab([anchor, ...part], startDate, endDate);
    const a = rs.find((r) => r.keyword === anchor);
    const aMean = a ? mean(dates.map((d) => a.data.get(d) || 0)) : 0;
    const k = aMean > 0 && anchorBase > 0 ? anchorBase / aMean : 1;
    rs.filter((r) => r.keyword !== anchor).forEach((r) => series.set(r.keyword, dates.map((d) => (r.data.get(d) || 0) * k)));
  }
  const out = list.map((kw) => {
    const s = series.get(kw) || dates.map(() => 0);
    const recent = mean(s.slice(-recentDays)), prior = mean(s.slice(0, -recentDays));
    const momentum = prior > 0 ? recent / prior - 1 : recent > 0 ? 1 : 0;
    const weeks = chunks(s, 7).map(mean), wMax = Math.max(...weeks, 0);
    return { keyword: kw, level: mean(s), momentum: +momentum.toFixed(3), spark: weeks.map((w) => (wMax ? +(w / wMax).toFixed(2) : 0)) };
  });
  const top = Math.max(...out.map((o) => o.level), 0);
  out.forEach((o) => (o.level = top ? Math.round((o.level / top) * 100) : 0));
  return out;
}

// ---------- 검색광고 키워드도구 ----------
const count = (v) => (typeof v === "number" ? v : /</.test(String(v)) ? 5 : parseInt(String(v).replace(/,/g, ""), 10) || 0);
async function keywordTool(hints) {
  const ts = String(Date.now());
  const sig = crypto.createHmac("sha256", env("NAVER_AD_SECRET")).update(`${ts}.GET./keywordstool`).digest("base64");
  const hint = hints.map((h) => h.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean).slice(0, 5).join(",");
  if (!hint) return [];
  const res = await fetch(`https://api.searchad.naver.com/keywordstool?hintKeywords=${encodeURIComponent(hint)}&showDetail=1`, {
    headers: { "X-Timestamp": ts, "X-API-KEY": env("NAVER_AD_API_KEY"), "X-Customer": env("NAVER_AD_CUSTOMER_ID"), "X-Signature": sig },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) throw new Error(`네이버 검색광고 API 인증 실패 (${res.status}) — NAVER_AD_API_KEY·NAVER_AD_SECRET·NAVER_AD_CUSTOMER_ID를 확인해 주세요`);
    if (res.status === 429) throw new Error("네이버 검색광고 API 호출이 너무 많습니다 (429). 잠시 후 다시 시도해 주세요");
    throw new Error(`네이버 검색광고 API 오류 (${res.status}): ${t.slice(0, 160)}`);
  }
  const j = await res.json();
  return (j.keywordList || []).map((k) => {
    const pc = count(k.monthlyPcQcCnt), mobile = count(k.monthlyMobileQcCnt);
    return { keyword: k.relKeyword, pc, mobile, volume: pc + mobile, comp: k.compIdx || "" };
  });
}

// ---------- 종합: 후보 키워드 → 검색량·추세·점수 ----------
// candidates: 직접 고른 후보, seeds: 연관 키워드를 넓힐 대표 검색어 (검색광고 키가 있을 때만 사용)
export async function keywordReport({ candidates = [], seeds = [], minVolume = 0, max = 15, related = 10 }) {
  const st = naverStatus();
  if (!st.datalab) throw new Error("네이버 데이터랩 키(NAVER_CLIENT_ID·NAVER_CLIENT_SECRET)가 설정되지 않았습니다");
  let pool = uniq(candidates);
  const vol = new Map();
  if (st.searchad) {
    const hints = uniq([...seeds, ...pool]).slice(0, 15);
    for (const part of chunks(hints, 5)) { (await keywordTool(part)).forEach((k) => vol.has(key(k.keyword)) || vol.set(key(k.keyword), k)); await sleep(150); }
    const extra = [...vol.values()].filter((k) => !pool.some((p) => key(p) === key(k.keyword)) && k.volume >= Math.max(minVolume, 50))
      .sort((a, b) => b.volume - a.volume).slice(0, related).map((k) => k.keyword);
    pool = uniq([...pool, ...extra]);
    pool = pool.filter((p) => !vol.has(key(p)) || vol.get(key(p)).volume >= minVolume)
      .sort((a, b) => (vol.get(key(b))?.volume ?? -1) - (vol.get(key(a))?.volume ?? -1));
  }
  pool = pool.slice(0, 20);
  if (!pool.length) return [];
  const trend = await trendOf(pool);
  const rows = trend.map((t) => {
    const v = vol.get(key(t.keyword));
    const base = v ? Math.log10(v.volume + 10) : Math.log10(t.level + 1) * 1.5;
    const score = base * (1 + Math.max(-0.5, Math.min(1, t.momentum)) * 0.6);
    return { ...t, volume: v ? v.volume : null, pc: v?.pc ?? null, mobile: v?.mobile ?? null, comp: v?.comp || "", score: +score.toFixed(3) };
  }).filter((r) => r.level > 0 || (r.volume || 0) > 0);
  return rows.sort((a, b) => b.score - a.score).slice(0, max);
}

// 프롬프트·화면에 쓰는 한 줄 표현
export const pct = (m) => `${m >= 0 ? "+" : ""}${Math.round(m * 100)}%`;
export const rowText = (r) => `${r.keyword} — ${r.volume != null ? `월 검색 약 ${r.volume.toLocaleString("ko-KR")}회` : `상대 검색량 ${r.level}`}, 최근 2주 추세 ${pct(r.momentum)}${r.comp ? `, 광고 경쟁 ${r.comp}` : ""}`;
