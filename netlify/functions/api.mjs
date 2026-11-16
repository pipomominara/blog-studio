// 블로그 스튜디오 (화이트라벨) — API
import crypto from "node:crypto";
import {
  STATUSES, EDITABLE, DEFAULT_SETTINGS, json, env, apiKey, claudeError, pubText, pubPost, pubEvent, nowKST, sign, verify, safeEqual,
  store, listJSON, getJSON, setJSON, getSettings, logActivity, savePost, nextPostId, findDuplicates, snapshot,
  normalizeProfile, publicBrand, normalizeThumbFormat, IMAGE_MODELS, insertMarker, removeMarker, markersIn,
} from "../lib/core.mjs";

export const config = { path: ["/api/*"] };

// AI 사진 작업이 10분 넘게 끝나지 않으면 멈춘 것으로 보고 잠금을 푼다
const imgBusy = (p) => !!p.imagesGenerating && Date.now() - (p.imagesGeneratingAt || 0) < 10 * 60 * 1000;
const summary = (p) => ({ ...p, imagesGenerating: imgBusy(p), body: undefined, bodyPreview: String(p.body || "").slice(0, 120) });

function csvEscape(v) { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

export default async (req) => {
  try {
    const url = new URL(req.url);
    const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
    const method = req.method;

    // 공개: 썸네일 배경 이미지
    if (route === "thumb-bg" && method === "GET") {
      const r = await store().get("assets/thumb-bg", { type: "arrayBuffer" });
      if (!r) return new Response("", { status: 404 });
      const meta = (await getJSON("assets/thumb-bg-meta")) || {};
      return new Response(r, { headers: { "content-type": meta.type || "image/png", "cache-control": "no-cache" } });
    }

    // 공개: 로그인 화면에 쓸 앱 이름·로고·색
    if (route === "brand" && method === "GET") return json(publicBrand(await getSettings()));

    const body = method === "GET" ? {} : await req.json().catch(() => ({}));

    if (route === "login" && method === "POST") {
      const name = String(body.name || "").trim().slice(0, 20);
      if (!name) return json({ error: "이름을 입력해 주세요" }, 400);
      // 관리자 비밀번호(ADMIN_PASSWORD)로 들어오면 관리자, 팀 비밀번호면 일반 사용자.
      // ADMIN_PASSWORD를 아직 설정하지 않았다면 팀 비밀번호 사용자를 관리자로 본다(초기 설정용)
      const adminPw = (process.env.ADMIN_PASSWORD || "").trim();
      const pw = body.password || "";
      let role = null;
      if (adminPw && safeEqual(pw, adminPw)) role = "admin";
      else if (safeEqual(pw, env("TEAM_PASSWORD"))) role = adminPw ? "member" : "admin";
      if (!role) return json({ error: "비밀번호가 맞지 않습니다" }, 401);
      await logActivity(name, "로그인", "-", role === "admin" ? "관리자" : "");
      return json({ token: sign({ name, role, exp: Date.now() + 14 * 24 * 3600 * 1000 }), name, role, adminPasswordSet: !!adminPw });
    }

    const token = (req.headers.get("authorization") || "").replace(/^Bearer /, "") || url.searchParams.get("t");
    const session = verify(token);
    if (!session) return json({ error: "다시 로그인해 주세요" }, 401);
    const who = session.name;
    const admin = session.role === "admin";
    const ADMIN_ONLY = /^(settings|settings\/test|settings\/image-test|thumb-bg|thumb-bg\/reset|usage)$/;
    if (ADMIN_ONLY.test(route) && !admin) return json({ error: "관리자만 사용할 수 있습니다" }, 403);
    const outPost = (p) => (admin ? p : pubPost(p));

    // ----- 조회 -----
    if (route === "data" && method === "GET") {
      const [posts, requests, bgMeta, settings] = await Promise.all([listJSON("posts/"), listJSON("requests/"), getJSON("assets/thumb-bg-meta"), getSettings()]);
      return json({
        me: who, role: admin ? "admin" : "member", adminPasswordSet: !!(process.env.ADMIN_PASSWORD || "").trim(), keywordSearchDefault: settings.keywordSearch !== false && settings.maxSearches > 0,
        brand: publicBrand(settings), thumbFormat: settings.thumbFormat, imageEnabled: !!(process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN), hasThumbBg: !!bgMeta, thumbBgVer: bgMeta?.at ? `${bgMeta.at}-${bgMeta.n || 0}` : "",
        posts: posts.map((p) => outPost(summary(p))).sort((a, b) => b.id.localeCompare(a.id)),
        requests: requests.filter((r) => ["대기", "작성중", "실패"].includes(r.state)).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
          .map(({ costUsd, costs, ...r }) => (admin ? { ...r, costUsd, costs } : { ...r, note: pubText(r.note) })),
      });
    }

    let m;
    if ((m = route.match(/^posts\/([\w-]+)$/)) && method === "GET") {
      const p = await getJSON(`posts/${m[1]}`);
      if (!p) return json({ error: "글을 찾을 수 없습니다" }, 404);
      const versions = (await listJSON(`versions/${m[1]}/`)).map(({ snapshot, ...v }) => (admin ? v : pubEvent(v))).sort((a, b) => b.n - a.n);
      p.imagesGenerating = imgBusy(p);
      return json({ post: outPost(p), versions });
    }
    if ((m = route.match(/^posts\/([\w-]+)\/versions\/(\d+)$/)) && method === "GET") {
      const v = await getJSON(`versions/${m[1]}/${String(m[2]).padStart(4, "0")}`);
      return v ? json(admin ? v : pubEvent(v)) : json({ error: "버전을 찾을 수 없습니다" }, 404);
    }

    if (route === "activity" && method === "GET") {
      const s = store();
      const { blobs } = await s.list({ prefix: "activity/" });
      const keys = blobs.map((b) => b.key).sort().reverse();
      const limit = Math.min(+url.searchParams.get("limit") || 300, 1000);
      const items = (await Promise.all(keys.slice(0, limit).map((k) => s.get(k, { type: "json" })))).filter(Boolean).map((e) => (admin ? e : pubEvent(e)));
      return json({ items, total: keys.length });
    }

    if (route === "check" && method === "POST") {
      const [posts, requests, settings] = await Promise.all([listJSON("posts/"), listJSON("requests/"), getSettings()]);
      return json({ duplicates: findDuplicates(body.keyword, posts, requests, settings.coveredTopics) });
    }

    // ----- 요청 -----
    // 기반 자료 업로드 (파일 1개씩). 텍스트는 브라우저에서 추출해 보내고, PDF·이미지는 base64 원본을 보낸다
    if (route === "sources" && method === "POST") {
      const kind = ["text", "pdf", "image"].includes(body.kind) ? body.kind : null;
      const name = String(body.name || "").slice(0, 200);
      if (!kind || !name) return json({ error: "자료 형식이 올바르지 않습니다" }, 400);
      let data, mediaType = "text/plain", size;
      if (kind === "text") {
        data = String(body.text || "").slice(0, 300000);
        if (!data.trim()) return json({ error: `${name}: 읽을 수 있는 글자가 없습니다` }, 400);
        size = data.length;
      } else {
        data = String(body.data || "");
        mediaType = kind === "pdf" ? "application/pdf" : String(body.mediaType || "");
        if (kind === "image" && !["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mediaType)) return json({ error: `${name}: 지원하지 않는 이미지 형식입니다` }, 400);
        if (!/^[A-Za-z0-9+/=]+$/.test(data)) return json({ error: `${name}: 파일 데이터가 올바르지 않습니다` }, 400);
        size = Math.floor(data.length * 0.75);
        if (size > 4 * 1024 * 1024) return json({ error: `${name}: 파일 하나는 4MB까지 올릴 수 있습니다` }, 400);
      }
      const sid = `S-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
      await setJSON(`sourcedata/${sid}`, { data });
      const meta = { sid, name, kind, mediaType, size, by: who, at: nowKST() };
      await setJSON(`sources/${sid}`, meta);
      return json({ ok: true, source: meta });
    }

    if (route === "requests" && method === "POST") {
      const type = body.type === "키워드" ? "키워드" : body.type === "자료" ? "자료" : "트렌드";
      const keyword = String(body.keyword || "").trim().slice(0, 100);
      const memo = String(body.memo || "").trim().slice(0, 500);
      let sourceIds = [], urls = [];
      if (type === "자료") {
        sourceIds = (Array.isArray(body.sourceIds) ? body.sourceIds : []).map(String).filter((s) => /^S-[\w-]+$/.test(s)).slice(0, 20);
        urls = (Array.isArray(body.urls) ? body.urls : []).map((u) => String(u).trim()).filter(Boolean).slice(0, 10);
        const bad = urls.find((u) => !/^https?:\/\/[^\s]+$/i.test(u));
        if (bad) return json({ error: `링크 형식이 올바르지 않습니다: ${bad}` }, 400);
        if (!sourceIds.length && !urls.length) return json({ error: "파일이나 링크를 하나 이상 넣어 주세요" }, 400);
        for (const s of sourceIds) if (!(await getJSON(`sources/${s}`))) return json({ error: "올린 자료를 찾을 수 없습니다. 다시 올려 주세요" }, 400);
      }
      if (type === "키워드" && !keyword) return json({ error: "키워드를 입력해 주세요" }, 400);
      if ((type === "키워드" || (type === "자료" && keyword)) && !body.force) {
        const [posts, requests, settings] = await Promise.all([listJSON("posts/"), listJSON("requests/"), getSettings()]);
        const duplicates = findDuplicates(keyword, posts, requests, settings.coveredTopics);
        if (duplicates.length) return json({ duplicates }, 409);
      }
      const requestId = `R-${nowKST().replace(/[-: ]/g, "").slice(2)}-${crypto.randomBytes(2).toString("hex")}`;
      const r = { requestId, requestedAt: nowKST(), requester: who, type, keyword, memo, forced: !!body.force, state: "대기", postId: await nextPostId(), note: "",
        ...(type === "자료" ? { sourceIds, urls, webSearch: !!body.webSearch } : {}),
        ...(type === "키워드" && typeof body.webSearch === "boolean" ? { webSearch: body.webSearch } : {}) };
      await setJSON(`requests/${requestId}`, r);
      const what = type === "트렌드" ? "트렌드 자동생성" : type === "자료" ? `자료 기반: 파일 ${sourceIds.length}개 · 링크 ${urls.length}개${keyword ? ` · 주제 ${keyword}` : ""}` : `키워드: ${keyword}${body.webSearch ? " (웹 검색 보완)" : ""}`;
      await logActivity(who, "글 요청", requestId, `${what}${body.force ? " (중복 경고 무시)" : ""}`);
      return json({ ok: true, requestId, job: { kind: "new", requestId } });
    }
    if ((m = route.match(/^jobs\/failed$/)) && method === "POST") {
      const note = `생성 작업을 시작하지 못했습니다 (${String(body.reason || "").slice(0, 200)}). [다시 시도]를 눌러 주세요.`;
      if (body.job?.kind === "new") {
        const r = await getJSON(`requests/${body.job.requestId}`);
        if (r && r.state === "대기") { r.state = "실패"; r.note = note; await setJSON(`requests/${r.requestId}`, r); }
      } else if (body.job?.kind === "rewrite") {
        const p = await getJSON(`posts/${body.job.postId}`);
        if (p) { p.rewriteError = note; await setJSON(`posts/${p.id}`, p); }
      }
      return json({ ok: true });
    }

    if ((m = route.match(/^requests\/([\w-]+)\/(retry|dismiss|cancel)$/)) && method === "POST") {
      const r = await getJSON(`requests/${m[1]}`);
      if (!r) return json({ error: "요청을 찾을 수 없습니다" }, 404);
      if (m[2] === "dismiss" || m[2] === "cancel") {
        if (r.state === "완료") return json({ error: "이미 완료된 요청입니다" }, 409);
        const was = r.state; r.state = "취소"; r.note = `${who} 취소 (${was} 상태에서)`; await setJSON(`requests/${m[1]}`, r);
        await logActivity(who, "요청 취소", r.requestId, `${was} 상태에서 취소`); return json({ ok: true });
      }
      if (r.state === "완료" || r.state === "취소") return json({ error: "다시 시도할 수 없는 요청입니다" }, 409);
      r.state = "대기"; r.note = ""; await setJSON(`requests/${m[1]}`, r);
      await logActivity(who, "요청 재시도", r.requestId, "");
      return json({ ok: true, job: { kind: "new", requestId: r.requestId } });
    }

    // ----- 글 수정·상태 -----
    // ----- 사진 -----
    if ((m = route.match(/^img\/([\w-]+)$/)) && method === "GET") {
      const d = await getJSON(`postimg/${m[1]}`);
      if (!d) return new Response("", { status: 404 });
      return new Response(Buffer.from(d.data, "base64"), { headers: { "content-type": d.mediaType || "image/jpeg", "cache-control": "private, max-age=31536000, immutable" } });
    }
    if ((m = route.match(/^posts\/([\w-]+)\/images\/(upload|ai)$/)) && method === "POST") {
      const p = await getJSON(`posts/${m[1]}`);
      if (!p) return json({ error: "글을 찾을 수 없습니다" }, 404);
      if (p.status === "발행완료") return json({ error: "발행완료 글은 사진을 바꿀 수 없습니다" }, 409);
      if (p.rewriting || imgBusy(p)) return json({ error: "다른 작업이 진행 중입니다. 잠시 후 시도해 주세요" }, 409);
      const pos = body.pos === "top" || body.pos === "end" || body.pos === "auto" ? body.pos : Number.isInteger(+body.pos) ? +body.pos : "end";
      if (m[2] === "upload") {
        const mm = String(body.dataUrl || "").match(/^data:(image\/(png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
        if (!mm) return json({ error: "JPG·PNG·WEBP 이미지를 올려 주세요" }, 400);
        if (mm[3].length * 0.75 > 4 * 1024 * 1024) return json({ error: "사진 하나는 4MB까지 올릴 수 있습니다" }, 400);
        const iid = `I-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
        await setJSON(`postimg/${iid}`, { data: mm[3], mediaType: mm[1] });
        const caption = String(body.caption || "").trim().slice(0, 80);
        p.images = [...(p.images || []), { iid, source: "upload", caption, by: who, at: nowKST() }];
        p.body = insertMarker(p.body, iid, pos === "auto" ? "end" : pos);
        await savePost(p, who, "사진 추가", `사진 업로드${caption ? `: ${caption}` : ""}`);
        return json({ ok: true, post: outPost(p) });
      }
      if (!(process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN)) return json({ error: "AI 사진 생성이 아직 설정되지 않았습니다. 관리자에게 문의해 주세요" }, 400);
      const count = Math.max(1, Math.min(4, parseInt(body.count, 10) || 1));
      const direction = String(body.direction || "").trim().slice(0, 300);
      const replace = body.replace && (p.images || []).some((x) => x.iid === body.replace) ? body.replace : null;
      p.imagesGenerating = true; p.imagesGeneratingAt = Date.now(); delete p.imageError; await setJSON(`posts/${p.id}`, p);
      await logActivity(who, "사진 생성 요청", p.id, `${replace ? "사진 다시 만들기" : `${count}장`}${direction ? ` · ${direction}` : ""}`);
      return json({ ok: true, post: outPost(p), job: { kind: "images", postId: p.id, count: replace ? 1 : count, direction, pos, replace, by: who } });
    }
    if ((m = route.match(/^posts\/([\w-]+)\/images\/failed$/)) && method === "POST") {
      const p = await getJSON(`posts/${m[1]}`);
      if (p?.imagesGenerating) { p.imagesGenerating = false; p.imageError = `작업을 시작하지 못했습니다 (${String(body.reason || "").slice(0, 100)})`; await setJSON(`posts/${p.id}`, p); }
      return json({ ok: true });
    }
    if ((m = route.match(/^posts\/([\w-]+)\/images\/([\w-]+)\/(update|delete)$/)) && method === "POST") {
      const p = await getJSON(`posts/${m[1]}`);
      if (!p) return json({ error: "글을 찾을 수 없습니다" }, 404);
      if (p.status === "발행완료") return json({ error: "발행완료 글은 사진을 바꿀 수 없습니다" }, 409);
      if (p.rewriting || imgBusy(p)) return json({ error: "다른 작업이 진행 중입니다. 잠시 후 시도해 주세요" }, 409);
      const img = (p.images || []).find((x) => x.iid === m[2]);
      if (!img) return json({ error: "사진을 찾을 수 없습니다" }, 404);
      if (m[3] === "delete") {
        p.images = p.images.filter((x) => x.iid !== img.iid);
        p.body = removeMarker(p.body, img.iid);
        await savePost(p, who, "사진 삭제", img.caption || img.iid);
      } else {
        if (typeof body.caption === "string") img.caption = body.caption.trim().slice(0, 80);
        if (body.pos !== undefined && body.pos !== "") {
          const pos = body.pos === "top" || body.pos === "end" ? body.pos : +body.pos;
          p.body = insertMarker(removeMarker(p.body, img.iid), img.iid, pos);
        }
        await savePost(p, who, "사진 수정", img.caption || img.iid);
      }
      return json({ ok: true, post: outPost(p) });
    }

    if ((m = route.match(/^posts\/([\w-]+)\/(save|status|restore)$/)) && method === "POST") {
      const p = await getJSON(`posts/${m[1]}`);
      if (!p) return json({ error: "글을 찾을 수 없습니다" }, 404);
      if (p.rewriting) return json({ error: "검토 의견을 반영해 다시 쓰는 중입니다. 잠시 후 시도해 주세요" }, 409);
      if (body.baseVersion && body.baseVersion !== p.version) return json({ error: `다른 사람이 먼저 수정했습니다 (현재 v${p.version}). 새로고침 후 다시 시도해 주세요` }, 409);
      const action = m[2];

      if (action === "restore") {
        const v = await getJSON(`versions/${p.id}/${String(body.n).padStart(4, "0")}`);
        if (!v) return json({ error: "버전을 찾을 수 없습니다" }, 404);
        if (p.status === "발행완료") return json({ error: "발행완료 글은 되돌릴 수 없습니다" }, 409);
        for (const f of EDITABLE) p[f] = v.snapshot[f] ?? "";
        if (Array.isArray(v.snapshot.images)) p.images = v.snapshot.images; // 사진 목록도 그 버전으로 (사진 파일은 지우지 않으므로 다시 보인다)
        const unapprove = p.status === "승인";
        if (unapprove) p.status = "초안";
        await savePost(p, who, "되돌리기", `v${v.n}(${v.at} ${v.by})로 되돌림${unapprove ? " · 승인 해제(다시 승인 필요)" : ""}`);
        return json({ ok: true, post: outPost(p) });
      }

      // 필드 수정 (save, status 공통)
      const fields = body.fields || {};
      const changed = [];
      if (p.status !== "발행완료") {
        for (const f of EDITABLE) {
          if (!(f in fields)) continue;
          const v = String(fields[f] ?? "").slice(0, f === "body" ? 20000 : 300);
          if (f === "publishDate" && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return json({ error: "발행 예정일 형식: YYYY-MM-DD" }, 400);
          if (v !== (p[f] ?? "")) { p[f] = v; changed.push(f); }
        }
      }
      const LABEL = { title: "제목", thumbH: "썸네일 강조", thumbT1: "썸네일 제목1", thumbT2: "썸네일 제목2", thumbT3: "썸네일 제목3", thumbSub: "썸네일 부제", body: "본문", tags: "태그", publishDate: "발행 예정일" };
      const changedText = changed.map((f) => LABEL[f]).join("·");

      if (action === "save") {
        if (!changed.length) return json({ ok: true, post: outPost(p), unchanged: true });
        const unapprove = p.status === "승인";
        if (unapprove) p.status = "초안";
        await savePost(p, who, "수정", `${changedText} 수정${unapprove ? " · 승인 해제(다시 승인 필요)" : ""}`);
        return json({ ok: true, post: outPost(p), unapproved: unapprove });
      }

      const status = body.status;
      if (!STATUSES.includes(status)) return json({ error: "알 수 없는 상태" }, 400);
      const memo = String(body.memo || "").trim().slice(0, 1000);
      if (status === "수정요청" && !memo) return json({ error: "무엇을 고칠지 메모를 남겨 주세요" }, 400);
      if (status === "발행완료") {
        if (!/^https?:\/\//.test(body.url || "")) return json({ error: "발행 URL을 입력해 주세요" }, 400);
        if (p.status !== "승인") return json({ error: "승인된 글만 발행완료로 바꿀 수 있습니다" }, 409);
        p.publishUrl = body.url; p.publishedAt = nowKST(); p.publishedBy = who;
      }
      if (status === "승인") { p.approvedBy = who; p.approvedAt = nowKST(); }
      if (memo) p.memos = [...(p.memos || []), { by: who, at: nowKST(), text: memo }];
      const prev = p.status;
      p.status = status;
      const detail = [changed.length ? `${changedText} 수정` : "", `${prev} → ${status}`, memo ? `메모: ${memo.slice(0, 100)}` : "", status === "발행완료" ? body.url : ""].filter(Boolean).join(" · ");
      await savePost(p, who, status === "초안" ? "초안으로" : status, detail);
      return json({ ok: true, post: outPost(p), job: status === "수정요청" && body.rewrite !== false ? { kind: "rewrite", postId: p.id } : null });
    }

    // ----- 설정 -----
    if (route === "settings" && method === "GET") return json({ settings: await getSettings(), defaults: { ...DEFAULT_SETTINGS, thumbFormat: normalizeThumbFormat({}) }, imageModels: IMAGE_MODELS, imageEnabled: !!(process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN) });
    if (route === "settings" && method === "POST") {
      const cur = await getSettings();
      const next = { ...cur };
      for (const k of ["model", "researchModel", "cta", "coveredTopics", "rules", "imageModel", "imageGuide"]) if (typeof body[k] === "string") next[k] = body[k].slice(0, 20000);
      if (!IMAGE_MODELS[next.imageModel]) next.imageModel = cur.imageModel;
      if (body.imageWidth !== undefined) next.imageWidth = Math.max(256, Math.min(2048, parseInt(body.imageWidth, 10) || 1344));
      if (body.imageHeight !== undefined) next.imageHeight = Math.max(256, Math.min(2048, parseInt(body.imageHeight, 10) || 768));
      if (body.thumbFormat && typeof body.thumbFormat === "object") next.thumbFormat = normalizeThumbFormat(body.thumbFormat);
      if (body.profile && typeof body.profile === "object") next.profile = normalizeProfile({ ...cur.profile, ...body.profile });
      if (body.maxSearches !== undefined) next.maxSearches = Math.max(0, Math.min(5, parseInt(body.maxSearches, 10) || 0));
      if (typeof body.keywordSearch === "boolean") next.keywordSearch = body.keywordSearch;
      await setJSON("settings/main", next);
      await logActivity(who, "설정 변경", "settings", Object.keys(body).filter((k) => body[k] !== cur[k]).join(", "));
      return json({ ok: true, settings: next });
    }
    if (route === "thumb-bg" && method === "POST") {
      const mm = String(body.dataUrl || "").match(/^data:(image\/(png|jpeg|webp));base64,(.+)$/);
      if (!mm) return json({ error: "PNG/JPG/WEBP 이미지를 올려 주세요" }, 400);
      const buf = Buffer.from(mm[3], "base64");
      if (buf.length > 4 * 1024 * 1024) return json({ error: "4MB 이하 이미지만 가능합니다" }, 400);
      await store().set("assets/thumb-bg", buf);
      const prevMeta = (await getJSON("assets/thumb-bg-meta")) || {};
      await setJSON("assets/thumb-bg-meta", { type: mm[1], at: nowKST(), by: who, n: (prevMeta.n || 0) + 1 });
      await logActivity(who, "썸네일 배경 변경", "settings", "");
      return json({ ok: true });
    }


    if (route === "thumb-bg/reset" && method === "POST") {
      await store().delete("assets/thumb-bg");
      await store().delete("assets/thumb-bg-meta");
      await logActivity(who, "썸네일 배경 초기화", "settings", "");
      return json({ ok: true });
    }

    // Claude API 연결 테스트 (키·모델·크레딧 확인)
    if (route === "settings/test" && method === "POST") {
      const settings = await getSettings();
      let key;
      try { key = apiKey(); } catch (e) { return json({ ok: false, message: e.message }); }
      const msgs = [];
      for (const [label, model] of [["글쓰기", String(body.model || settings.model).trim()], ["조사", String(body.researchModel || settings.researchModel).trim()]]) {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: "user", content: "ping" }] }),
        });
        if (!res.ok) return json({ ok: false, message: `${label} 모델(${model}): ${claudeError(res.status, await res.text())}` });
        msgs.push(`${label} ${model}`);
      }
      return json({ ok: true, message: `연결 성공 — ${msgs.join(", ")} 사용 가능 (키 끝자리 …${key.slice(-4)})` });
    }

    // 월별 API 비용 추정 (글 생성·재작성·실패 포함)
    // AI 사진 테스트 (관리자): 백그라운드에서 만들고 결과를 assets/imagetest에 저장
    if (route === "settings/image-test" && method === "POST") {
      if (!(process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN)) return json({ error: "Netlify 환경변수 CF_ACCOUNT_ID, CF_API_TOKEN을 먼저 설정하고 재배포해 주세요" }, 400);
      await setJSON("assets/imagetest", { state: "running", at: nowKST() });
      return json({ ok: true, job: { kind: "imagetest", subject: String(body.subject || "").slice(0, 200) } });
    }
    if (route === "settings/image-test" && method === "GET") {
      return json((await getJSON("assets/imagetest")) || { state: "none" });
    }

    if (route === "usage" && method === "GET") {
      const [posts, requests] = await Promise.all([listJSON("posts/"), listJSON("requests/")]);
      const months = {};
      for (const d of [...posts, ...requests]) for (const c of d.costs || []) {
        const mth = c.at.slice(0, 7); months[mth] ||= { usd: 0, count: 0 }; months[mth].usd += c.usd; months[mth].count++;
      }
      return json({ months: Object.entries(months).sort((a, b) => b[0].localeCompare(a[0])).map(([month, v]) => ({ month, usd: +v.usd.toFixed(3), count: v.count })) });
    }

    if (route === "export.csv" && method === "GET") {
      const posts = (await listJSON("posts/")).sort((a, b) => a.id.localeCompare(b.id));
      const cols = ["id", "createdAt", "status", "title", "keyword", "reason", "thumbH", "thumbT1", "thumbT2", "thumbSub", "tags", "charCount", "publishDate", "publishUrl", "requester", "approvedBy", "updatedBy", "updatedAt", "body"];
      const csv = "﻿" + [cols.join(","), ...posts.map((p) => cols.map((c) => csvEscape(p[c])).join(","))].join("\n");
      return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="blog-${nowKST().slice(0, 10)}.csv"` } });
    }

    return json({ error: "없는 경로" }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: e.message || "서버 오류" }, 500);
  }
};
