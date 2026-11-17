// 블로그 스튜디오 (화이트라벨) — 공통 모듈 (저장소, 인증, 중복 검사, 히스토리)
import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";

export const STATUSES = ["초안", "승인", "수정요청", "발행완료", "보류"];
export const EDITABLE = ["title", "thumbH", "thumbT1", "thumbT2", "thumbT3", "thumbSub", "body", "tags", "publishDate"];

// ---------- 썸네일 문구 형식 (관리자가 설정에서 변경) ----------
// lines[i]는 글의 thumbH, thumbT1, thumbT2, thumbT3 칸에 차례로 대응하고, subtitle은 thumbSub에 대응한다
export const THUMB_LINE_KEYS = ["thumbH", "thumbT1", "thumbT2", "thumbT3"];
export const DEFAULT_THUMB_FORMAT = {
  lines: [
    { label: "강조", color: "#00cc00", size: 137, weight: 900, maxChars: 6, opacity: 1 },
    { label: "제목 1줄", color: "#fdfdfb", size: 137, weight: 900, maxChars: 7, opacity: 1 },
    { label: "제목 2줄", color: "#ffffff", size: 137, weight: 900, maxChars: 7, opacity: 1 },
  ],
  subtitle: { enabled: true, label: "부제", color: "#f6f2ed", size: 43, weight: 400, maxChars: 16, opacity: 0.84 },
  align: "left",        // left | center | right
  vAlign: "top",        // top(위 여백 y 사용) | middle | bottom
  top: 243,             // 상단 정렬: 위 여백 / 하단 정렬: 아래 여백 (px)
  marginX: 151,         // 왼쪽(가운데 정렬이면 좌우) 여백
  lineHeight: 1.15,     // 큰 줄 간격 배수
  subGap: 22,           // 마지막 큰 줄과 부제 사이 간격(px)
};
const clamp = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);
const color = (v, d) => (/^#[0-9a-f]{6}$/i.test(String(v)) ? String(v) : d);
function normStyle(s = {}, d) {
  return {
    label: String(s.label ?? d.label).slice(0, 20) || d.label,
    color: color(s.color, d.color), size: clamp(s.size, 12, 220, d.size),
    weight: [400, 700, 900].includes(+s.weight) ? +s.weight : d.weight,
    maxChars: clamp(s.maxChars, 1, 40, d.maxChars), opacity: clamp(s.opacity, 0.1, 1, d.opacity),
  };
}
export function normalizeThumbFormat(f = {}) {
  const D = DEFAULT_THUMB_FORMAT;
  const lines = (Array.isArray(f.lines) && f.lines.length ? f.lines : D.lines).slice(0, 4)
    .map((l, i) => normStyle(l, D.lines[Math.min(i, D.lines.length - 1)]));
  return {
    lines,
    subtitle: { enabled: f.subtitle ? f.subtitle.enabled !== false : true, ...normStyle(f.subtitle || {}, D.subtitle) },
    align: ["center", "right"].includes(f.align) ? f.align : "left",
    vAlign: ["top", "middle", "bottom"].includes(f.vAlign) ? f.vAlign : "top",
    top: clamp(f.top, 0, 1000, D.top), marginX: clamp(f.marginX, 0, 500, D.marginX),
    lineHeight: clamp(f.lineHeight, 0.8, 2, D.lineHeight), subGap: clamp(f.subGap, 0, 300, D.subGap),
  };
}
// 글쓰기 모델에 줄 썸네일 문구 지시 (현재 형식 기준)
export function thumbSpec(fmt) {
  const parts = fmt.lines.map((l, i) => ({ key: ["h", "t1", "t2", "t3"][i], label: l.label, max: l.maxChars }));
  if (fmt.subtitle.enabled) parts.push({ key: "sub", label: fmt.subtitle.label, max: fmt.subtitle.maxChars });
  return parts;
}
export const THUMB_JSON_KEY = { h: "thumbH", t1: "thumbT1", t2: "thumbT2", t3: "thumbT3", sub: "thumbSub" };

// ---------- 본문 속 사진 표시 ----------
// 본문에 [[사진:ID]] 한 줄로 사진 위치를 표시한다
// CTA 첫 줄(설정값). getSettings()가 채운다 — '본문 끝' 위치를 CTA 앞으로 잡는 데 쓴다
let ctaHead = "";
export const ctaHeadOf = (cta) => String(cta || "").split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 30) || "";
export function stripCTA(body, cta) {
  const head = ctaHeadOf(cta); let b = String(body || "");
  if (head) { const i = b.indexOf(head); if (i >= 0) b = b.slice(0, i); }
  return b.trim();
}
export const withCTA = (body, cta) => (String(cta || "").trim() ? `${String(body).trim()}\n\n${String(cta).trim()}` : String(body).trim());
export const IMG_MARK = (iid) => `[[사진:${iid}]]`;
export const IMG_MARK_RE = /^\[\[사진:([\w-]+)\]\]$/;
export function bodyHeadings(body) {
  return String(body || "").split("\n").map((l, i) => ({ line: i, text: l.trim() })).filter((x) => x.text.startsWith("## ")).map((x) => ({ ...x, text: x.text.slice(3) }));
}
// pos: "top" | "end" | 소제목 번호(0부터)
export function insertMarker(body, iid, pos) {
  const lines = String(body || "").split("\n");
  const mark = IMG_MARK(iid);
  const hs = bodyHeadings(body);
  if (pos === "top") { lines.splice(0, 0, mark, ""); return lines.join("\n"); }
  if (Number.isInteger(+pos) && hs[+pos]) {
    // 소제목 바로 아래, 첫 문단 다음에 둔다
    let i = hs[+pos].line + 1;
    while (i < lines.length && !lines[i].trim()) i++;
    while (i < lines.length && lines[i].trim() && !lines[i].trim().startsWith("## ") && !IMG_MARK_RE.test(lines[i].trim())) i++;
    lines.splice(i, 0, "", mark);
    return lines.join("\n").replace(/\n{3,}/g, "\n\n");
  }
  // end: CTA 문단 앞
  const cta = ctaHead ? lines.findIndex((l) => l.trim().startsWith(ctaHead)) : -1;
  const at = cta >= 0 ? cta : lines.length;
  lines.splice(at, 0, mark, "");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}
export function removeMarker(body, iid) {
  return String(body || "").split("\n").filter((l) => l.trim() !== IMG_MARK(iid)).join("\n").replace(/\n{3,}/g, "\n\n");
}
export const markersIn = (body) => String(body || "").split("\n").map((l) => l.trim().match(IMG_MARK_RE)?.[1]).filter(Boolean);

// ---------- Cloudflare Workers AI 이미지 생성 ----------
export const IMAGE_MODELS = {
  "@cf/black-forest-labs/flux-1-schnell": { label: "FLUX.1 schnell (빠름·매우 저렴)", sizes: false, usd: 0.001 },
  "@cf/leonardo/lucid-origin": { label: "Leonardo Lucid Origin (고품질·크기 지정)", sizes: true, usd: 0.03 },
  "@cf/leonardo/phoenix-1.0": { label: "Leonardo Phoenix 1.0 (고품질·크기 지정)", sizes: true, usd: 0.025 },
};
export const imageUsd = (model) => IMAGE_MODELS[model]?.usd ?? 0.02;
const cfCred = (name) => env(name).trim().replace(/^["']+|["']+$/g, "").trim();
function sniff(b64) {
  if (b64.startsWith("/9j/")) return "image/jpeg";
  if (b64.startsWith("iVBOR")) return "image/png";
  if (b64.startsWith("UklGR")) return "image/webp";
  return "image/jpeg";
}
export async function cfGenerateImage({ model, prompt, width, height, seed }) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${cfCred("CF_ACCOUNT_ID")}/ai/run/${model}`;
  // 모델마다 받는 입력이 달라서 꼭 필요한 값만 보낸다 (flux-1-schnell은 seed를 받지 않는다)
  const body = { prompt: String(prompt).slice(0, 2000) };
  if (model.includes("flux-1-schnell")) body.steps = 8;
  if (IMAGE_MODELS[model]?.sizes) { body.width = width; body.height = height; }
  const call = () => fetch(url, { method: "POST", headers: { authorization: `Bearer ${cfCred("CF_API_TOKEN")}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  let res = await call();
  // 모델이 특정 입력을 거부하면(400 "properties '/xxx' not allowed") 그 값을 빼고 다시 시도
  for (let i = 0; i < 3 && res.status === 400; i++) {
    const t = await res.clone().text().catch(() => "");
    const bad = t.match(/properties '\/(\w+)'/)?.[1];
    if (!bad || bad === "prompt" || !(bad in body)) break;
    delete body[bad];
    res = await call();
  }
  const ct = res.headers.get("content-type") || "";
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) throw new Error(`Cloudflare 인증 실패 (${res.status}). CF_ACCOUNT_ID·CF_API_TOKEN(Workers AI 권한)을 확인해 주세요.`);
    if (res.status === 429) throw new Error("Cloudflare 이미지 생성 한도에 걸렸습니다 (429). 잠시 후 다시 시도해 주세요.");
    throw new Error(`Cloudflare 이미지 생성 오류 (${res.status}): ${t.slice(0, 200)}`);
  }
  if (ct.startsWith("image/")) return { mediaType: ct.split(";")[0], data: Buffer.from(await res.arrayBuffer()).toString("base64") };
  const j = await res.json();
  const img = j?.result?.image || j?.image;
  if (!img) throw new Error("Cloudflare 응답에 이미지가 없습니다 (안전 필터에 걸렸을 수 있습니다). 방향을 바꿔 다시 시도해 주세요.");
  return { mediaType: sniff(img), data: img };
}

export const DEFAULT_SETTINGS = {
  model: "claude-sonnet-5-5",          // 글쓰기 모델
  imageModel: "@cf/black-forest-labs/flux-1-schnell", // 사진 생성 모델 (Cloudflare Workers AI)
  imageWidth: 1344, imageHeight: 768,  // 크기 지정 모델용 (가로형)
  imageGuide: `블로그 본문에 어울리는 사실적인 사진 스타일.
밝고 깨끗한 분위기, 자연광 같은 부드러운 조명.
이미지 안에 글자·숫자·로고·워터마크를 넣지 않는다.
사람은 뒷모습이나 손 위주로 자연스럽게, 얼굴 클로즈업은 피한다.
특정 브랜드 로고나 실제 제품 디자인을 재현하려 하지 않는다.
가로형 블로그 사진 구도, 과한 색보정 없이 자연스러운 색감.`,
  researchModel: "claude-haiku-5-5",   // 웹 검색·조사 모델 (저렴)
  maxSearches: 3,                      // 글 1건당 웹 검색 최대 횟수 (0이면 검색 안 함)
  keywordSearch: true,
  naverTrend: true,                    // 네이버 검색 데이터로 트렌드 키워드 고르기 (키가 있을 때)
  naverMinVolume: 100,                 // 월 검색수가 이보다 적은 후보는 제외 (검색광고 키가 있을 때)
  naverCandidates: 15,                 // 조사 모델이 뽑는 후보 키워드 수                 // 키워드 요청에도 검색할지
  cta: "",                             // 본문 끝에 자동으로 붙는 문구 (고객별로 입력)
  coveredTopics: "",
  // 고객 프로필: 고객마다 바꾸는 값. 글쓰기·조사·사진 프롬프트에 자동으로 들어간다
  profile: {
    appName: "블로그 스튜디오", logoText: "", accent: "#00a800",
    company: "", industry: "", products: "", audience: "", tone: "간결하고 직접적이며 전문적. 존댓말.",
    topics: "", avoid: "", tags: "", naverBlogId: "",
  },
  rules: `[글 구조]
- 제목: 핵심 키워드 포함, 40자 내외
- 도입부 2문단: 주제를 간결하게 요약
- 본문: "## 소제목" 4~6개 + 마무리 소제목. 목록은 "- "로 시작
- CTA는 쓰지 않는다 (시스템이 자동으로 붙인다)
- 본문 공백 포함 1,500자 이상

[작성 원칙]
- 이모지 금지. 키워드 남용 금지, 자연스러운 흐름
- 독자가 바로 써먹을 수 있는 구체적인 정보·사례·체크리스트 위주로 쓴다
- 상품·서비스는 글 흐름에 맞게 자연스럽게 연결하고, 과장 광고 문구는 쓰지 않는다
- 다른 소스 내용을 그대로 복사하지 않는다
- 수치·통계는 출처를 확인한 것만 쓰고, 출처가 불분명한 경쟁사·외부 수치는 쓰지 않는다
- 상품 기능·효과·가격을 언급한 문장은 factCheck 목록에 넣는다

[태그] "#태그" 형식 8~11개`,
};


// ---------- 공통 ----------
export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`환경변수 ${name}가 설정되지 않았습니다`);
  return v;
}

export function nowKST() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
}
// 모델별 가격 (USD / 100만 토큰) — 비용 추정용. console.anthropic.com 청구액이 기준
const PRICES = { fable: { in: 10, out: 50 }, opus: { in: 4, out: 20 }, sonnet: { in: 2, out: 10 }, haiku: { in: 0.1, out: 0.5 } };
export function priceOf(model) {
  const k = Object.keys(PRICES).find((x) => String(model).includes(x));
  return PRICES[k] || PRICES.sonnet;
}

// ---------- 일반 사용자용 표시 정리 ----------
// 관리자가 아닌 사용자에게는 AI 공급사 이름과 비용을 보여주지 않는다
export function pubText(s) {
  return String(s ?? "")
    .replace(/\s*·\s*약\s*\$[0-9.]+/g, "")
    .replace(/Claude API/g, "AI 서비스")
    .replace(/Claude 재작성/g, "자동 재작성")
    .replace(/Claude/g, "시스템")
    .replace(/claude-[a-z0-9.-]+/gi, "AI 모델")
    .replace(/Cloudflare/g, "이미지 서비스")
    .replace(/CF_ACCOUNT_ID·CF_API_TOKEN\(Workers AI 권한\)을 확인해 주세요\./g, "관리자에게 문의해 주세요.");
}
export function pubPost(p) {
  if (!p) return p;
  const { costUsd, costs, ...rest } = p;
  return {
    ...rest,
    updatedBy: pubText(rest.updatedBy),
    rewriteError: rest.rewriteError ? pubText(rest.rewriteError) : rest.rewriteError,
    imageError: rest.imageError ? pubText(rest.imageError) : rest.imageError,
    memos: (rest.memos || []).map((m) => ({ ...m, by: pubText(m.by), text: pubText(m.text) })),
  };
}
export const pubEvent = (e) => e && ({ ...e, by: pubText(e.by), action: pubText(e.action), detail: pubText(e.detail) });

// 붙여넣을 때 섞인 공백·따옴표·줄바꿈 제거
export const apiKey = () => env("ANTHROPIC_API_KEY").trim().replace(/^["']+|["']+$/g, "").trim();

export function claudeError(status, text) {
  const t = String(text || "");
  if (status === 401) return "Claude API 키가 올바르지 않습니다 (401). Netlify 환경변수 ANTHROPIC_API_KEY 값을 확인하고 재배포해 주세요.";
  if (status === 403) return "이 API 키로는 요청 권한이 없습니다 (403). console.anthropic.com에서 키 상태를 확인해 주세요.";
  if (status === 404 || /model/i.test(t) && status === 400 && /not.?found|invalid/i.test(t)) return "Claude 모델 ID를 찾을 수 없습니다. 설정 → Claude 모델 ID를 확인해 주세요.";
  if (status === 400 && /credit|balance/i.test(t)) return "Claude API 크레딧이 부족합니다. console.anthropic.com → Billing에서 충전해 주세요.";
  if (status === 429) return "요청이 너무 많습니다 (429). 잠시 후 다시 시도해 주세요.";
  if (status >= 500) return `Claude 서버가 일시적으로 응답하지 않습니다 (${status}). 잠시 후 다시 시도해 주세요.`;
  return `Claude API 오류 (${status}): ${t.slice(0, 200)}`;
}
export const todayKST = () => nowKST().slice(0, 10);
export const store = () => getStore({ name: "blog-studio", consistency: "strong" });

// ---------- 인증 ----------
const b64url = (b) => Buffer.from(b).toString("base64url");
export function sign(payload) {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${crypto.createHmac("sha256", env("SESSION_SECRET")).update(body).digest("base64url")}`;
}
export function verify(token) {
  if (!token || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  const expect = crypto.createHmac("sha256", env("SESSION_SECRET")).update(body).digest("base64url");
  if (mac.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}
export function safeEqual(a, b) {
  return crypto.timingSafeEqual(crypto.createHash("sha256").update(String(a)).digest(), crypto.createHash("sha256").update(String(b)).digest());
}
export const internalSecret = () => crypto.createHmac("sha256", env("SESSION_SECRET")).update("internal-job").digest("hex");

// ---------- 저장소 ----------
export async function listJSON(prefix) {
  const s = store();
  const { blobs } = await s.list({ prefix });
  const items = await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })));
  return items.filter(Boolean);
}
export const getJSON = (key) => store().get(key, { type: "json" });
export const setJSON = (key, v) => store().setJSON(key, v);

// ---------- 고객 프로필 ----------
const PROFILE_LIMITS = { appName: 30, logoText: 16, accent: 7, company: 60, industry: 200, products: 2000, audience: 2000, tone: 2000, topics: 2000, avoid: 2000, tags: 300, naverBlogId: 40 };
export function normalizeProfile(pf = {}) {
  const D = DEFAULT_SETTINGS.profile, o = {};
  for (const k of Object.keys(PROFILE_LIMITS)) o[k] = String(pf?.[k] ?? D[k]).slice(0, PROFILE_LIMITS[k]).trim();
  if (!o.appName) o.appName = D.appName;
  if (!/^#[0-9a-f]{6}$/i.test(o.accent)) o.accent = D.accent;
  o.naverBlogId = o.naverBlogId.replace(/[^\w-]/g, "");
  return o;
}
// 로그인 전 화면에도 필요한 공개 정보 (이름·로고·색)
export const publicBrand = (s) => ({ appName: s.profile.appName, logoText: s.profile.logoText, accent: s.profile.accent, naverBlogId: s.profile.naverBlogId });
// 조사·글쓰기 프롬프트 맨 앞에 붙는 고객 소개
export const whoOf = (pf) => `${pf.company || "이 회사"}${pf.industry ? `(${pf.industry})` : ""}`;
export function profileBlock(pf) {
  const row = (t, v) => (v ? `[${t}]\n${v}\n\n` : "");
  return (`[역할] ${whoOf(pf)}의 네이버 블로그 담당 마케터로서 글을 쓴다.\n\n`
    + row("주력 상품·서비스", pf.products) + row("타깃 독자", pf.audience) + row("톤앤매너", pf.tone)
    + row("소재 발굴 축", pf.topics) + row("주의·금지 사항", pf.avoid) + row("꼭 넣을 태그", pf.tags)).trim();
}

export async function getSettings() {
  const s = { ...DEFAULT_SETTINGS, ...((await getJSON("settings/main")) || {}) };
  s.thumbFormat = normalizeThumbFormat(s.thumbFormat);
  s.profile = normalizeProfile(s.profile);
  ctaHead = ctaHeadOf(s.cta);
  return s;
}

export async function logActivity(by, action, target, detail = "") {
  const at = nowKST();
  const key = `activity/${new Date().toISOString()}-${crypto.randomBytes(3).toString("hex")}`;
  await setJSON(key, { at, by, action, target, detail: String(detail).slice(0, 300) });
}

export function snapshot(p) {
  const o = {};
  for (const f of [...EDITABLE, "status", "publishUrl"]) o[f] = p[f] ?? "";
  o.images = p.images || [];
  return o;
}

// 글 저장 + 버전 기록 + 활동 기록
export async function savePost(post, by, action, detail = "") {
  post.version = (post.version || 0) + 1;
  post.updatedBy = by;
  post.updatedAt = nowKST();
  post.charCount = String(post.body || "").length;
  await setJSON(`posts/${post.id}`, post);
  await setJSON(`versions/${post.id}/${String(post.version).padStart(4, "0")}`, {
    n: post.version, at: post.updatedAt, by, action, detail: String(detail).slice(0, 300), snapshot: snapshot(post),
  });
  await logActivity(by, action, post.id, detail || post.title);
  return post;
}

export async function nextPostId() {
  const year = todayKST().slice(0, 4);
  const { blobs } = await store().list({ prefix: "posts/" });
  let max = 0;
  for (const b of blobs) {
    const m = b.key.match(/posts\/B-(\d{4})-(\d{3,})$/);
    if (m && m[1] === year) max = Math.max(max, +m[2]);
  }
  const reserved = await listJSON("requests/");
  for (const r of reserved) {
    const m = (r.postId || "").match(/^B-(\d{4})-(\d{3,})$/);
    if (m && m[1] === year) max = Math.max(max, +m[2]);
  }
  return `B-${year}-${String(max + 1).padStart(3, "0")}`;
}

// 오늘 이후 아직 안 쓰인 가장 빠른 화/목
export function nextPublishDate(posts) {
  const used = new Set(posts.map((p) => p.publishDate));
  const d = new Date(todayKST() + "T00:00:00Z");
  for (let i = 1; i < 120; i++) {
    d.setUTCDate(d.getUTCDate() + 1);
    const iso = d.toISOString().slice(0, 10);
    if ([2, 4].includes(d.getUTCDay()) && !used.has(iso)) return iso;
  }
  return "";
}

// ---------- 중복 검사 ----------
const norm = (s) => String(s || "").toLowerCase().replace(/[^0-9a-z가-힣]/g, "");
const tokens = (s) => String(s || "").toLowerCase().split(/[\s,/·|#]+/).map(norm).filter((t) => t.length >= 2);

export function findDuplicates(keyword, posts, requests = [], coveredTopics = "") {
  const k = norm(keyword);
  const kt = new Set(tokens(keyword));
  if (!k) return [];
  const hits = [];
  const check = (ref, label, text) => {
    const n = norm(text);
    if (!n) return;
    let reason = null;
    if (n.includes(k) || (k.length >= 4 && k.includes(n))) reason = "키워드 포함";
    else {
      const tt = new Set(tokens(text));
      const inter = [...kt].filter((t) => tt.has(t) || [...tt].some((x) => x.length >= 3 && (x.includes(t) || t.includes(x))));
      if (kt.size && inter.length / kt.size >= 0.6) reason = `단어 겹침: ${inter.join(", ")}`;
    }
    if (reason) hits.push({ ref, label, text, reason });
  };
  for (const p of posts) { check(p.id, "키워드", p.keyword); check(p.id, "제목", p.title); }
  for (const r of requests) if (["대기", "작성중"].includes(r.state) && r.keyword) check(r.requestId, "진행 중 요청", r.keyword);
  String(coveredTopics).split("\n").filter(Boolean).forEach((t, i) => check(`기존주제${i + 1}`, "이미 다룬 주제", t));
  const seen = new Set();
  return hits.filter((h) => (seen.has(h.ref) ? false : seen.add(h.ref)));
}
