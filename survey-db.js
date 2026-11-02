// 설문 응답 저장(파이어베이스 Firestore)과 관리자 모드(비밀번호 확인 → 기간별 결과 그래프, 조별 비교)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, addDoc, serverTimestamp, query, where, orderBy, getDocs, Timestamp,
  doc, getDoc, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, ADMIN_PASSWORD_HASH, COLLECTION } from "./firebase-config.js";

const $ = (id) => document.getElementById(id);
const ALL = window.SURVEYS;
const FONT = '"맑은 고딕", "Malgun Gothic", sans-serif';

// 설정 값이 아직 예시 그대로면 저장·조회를 하지 않음
const configured = !!firebaseConfig && !!firebaseConfig.apiKey && !/^YOUR_/.test(firebaseConfig.apiKey) &&
  !!firebaseConfig.projectId && !/^YOUR_/.test(firebaseConfig.projectId);

let db = null;
let charts = []; // 관리자 화면 그래프 목록
if (configured) {
  try {
    db = getFirestore(initializeApp(firebaseConfig));
  } catch (e) {
    console.error("[firebase] 초기화 실패", e);
  }
}

/* ───────── 1. 응답 저장 ───────── */
window.addEventListener("survey:done", async (e) => {
  const msg = $("db-msg");
  if (!db) { msg.hidden = true; return; }
  msg.hidden = false;
  msg.textContent = "응답을 저장하는 중입니다…";
  try {
    await addDoc(collection(db, COLLECTION), { ...e.detail, createdAt: serverTimestamp() });
    msg.textContent = "응답이 저장되었습니다.";
  } catch (err) {
    console.error("[firebase] 저장 실패", err);
    msg.textContent = "응답을 저장하지 못했습니다. 인터넷 연결을 확인해 주세요. (결과 보기에는 영향이 없습니다.)";
  }
});

/* ───────── 2. 관리자 비밀번호 모달 ───────── */
// 비밀번호는 코드에 그대로 적지 않고 SHA-256 해시 값으로만 다룸.
// - 처음 비밀번호: firebase-config.js의 ADMIN_PASSWORD_HASH
// - 관리자 모드에서 바꾼 비밀번호: Firestore adminKeys/{해시 값} 문서 (목록 보기가 막혀 있어 해시 값을 알아낼 수 없음)
const DEFAULT_HASH = String(ADMIN_PASSWORD_HASH).toLowerCase();
let currentHash = null; // 관리자 모드에 들어온 비밀번호의 해시 값 (비밀번호 바꿀 때 씀)
async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
// 입력한 비밀번호가 지금 비밀번호와 맞는지 확인
async function checkHash(h) {
  if (!db) return h === DEFAULT_HASH; // 파이어베이스 설정 전에는 처음 비밀번호로만 확인
  const snap = await getDoc(doc(db, "adminKeys", h));
  if (snap.exists()) return snap.data().active === true;
  return h === DEFAULT_HASH; // 아직 한 번도 바꾸지 않았으면 처음 비밀번호
}
const modal = $("pw-modal");
function askPassword(notice) {
  $("pw-input").value = "";
  $("pw-msg").textContent = "";
  $("pw-notice").textContent = notice || "";
  $("pw-notice").hidden = !notice;
  if (typeof modal.showModal === "function") modal.showModal(); else modal.setAttribute("open", "");
  $("pw-input").focus();
}
function closeModal() { if (modal.open) modal.close(); else modal.removeAttribute("open"); }
$("btn-admin").addEventListener("click", () => askPassword());
$("pw-cancel").addEventListener("click", closeModal);
$("pw-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pw = $("pw-input").value;
  $("pw-ok").disabled = true;
  $("pw-msg").textContent = "";
  let h = null, ok = false;
  try {
    h = await sha256(pw);
    ok = await checkHash(h);
  } catch (err) {
    console.error("[admin] 비밀번호 확인 실패", err);
    $("pw-msg").textContent = "비밀번호를 확인하지 못했습니다. 인터넷 연결을 확인해 주세요.";
    $("pw-ok").disabled = false;
    return;
  }
  $("pw-ok").disabled = false;
  if (!ok) {
    $("pw-msg").textContent = "비밀번호가 맞지 않습니다.";
    $("pw-input").select();
    return;
  }
  currentHash = h;
  closeModal();
  openAdmin();
});

/* ───────── 2-1. 관리자 비밀번호 바꾸기 ───────── */
$("pc-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const m = $("pc-msg");
  const p1 = $("pc-new").value, p2 = $("pc-new2").value;
  if (!db) { m.textContent = "firebase-config.js 설정이 되어 있어야 비밀번호를 바꿀 수 있습니다."; return; }
  if (!currentHash) { m.textContent = "다시 로그인해 주세요."; return; }
  if (p1.length < 4) { m.textContent = "새 비밀번호는 4자 이상으로 정해 주세요."; return; }
  if (p1 !== p2) { m.textContent = "새 비밀번호와 확인 입력이 서로 다릅니다."; return; }
  $("pc-go").disabled = true;
  m.textContent = "비밀번호를 바꾸는 중입니다…";
  try {
    const newHash = await sha256(p1);
    if (newHash === currentHash) { m.textContent = "지금 쓰는 비밀번호와 다른 비밀번호를 정해 주세요."; return; }
    if (newHash === DEFAULT_HASH) { m.textContent = "처음 비밀번호로는 되돌릴 수 없습니다. 다른 비밀번호를 정해 주세요."; return; }
    const oldRef = doc(db, "adminKeys", currentHash);
    const oldSnap = await getDoc(oldRef);
    const batch = writeBatch(db);
    // 새 비밀번호 켜기 + 지금 비밀번호 끄기를 한 번에 저장
    batch.set(doc(db, "adminKeys", newHash), { active: true, prev: currentHash, createdAt: serverTimestamp() });
    if (oldSnap.exists()) batch.update(oldRef, { active: false });
    else batch.set(oldRef, { active: false, createdAt: serverTimestamp() }); // 처음 비밀번호 끄기
    await batch.commit();
    // 자동 로그아웃 → 새 비밀번호로 다시 들어오기
    closeAdmin();
    askPassword("비밀번호가 바뀌었습니다. 새 비밀번호로 다시 들어와 주세요.");
  } catch (err) {
    console.error("[admin] 비밀번호 변경 실패", err);
    m.textContent = err && err.code === "permission-denied"
      ? "비밀번호를 바꾸지 못했습니다. 다른 곳에서 이미 바뀌었을 수 있으니 다시 로그인해 주세요."
      : "비밀번호를 바꾸지 못했습니다. 인터넷 연결을 확인해 주세요.";
  } finally {
    $("pc-go").disabled = false;
  }
});

/* ───────── 3. 관리자 화면 전환 ───────── */
const views = () => Array.prototype.slice.call(document.querySelectorAll("main.app > .view"));
function openAdmin() {
  document.querySelector("main.app").classList.add("wide"); // 관리자 화면만 넓게
  views().forEach((v) => { v.hidden = v.id !== "view-admin"; });
  window.scrollTo(0, 0);
  if (!db) {
    $("a-msg").textContent = "firebase-config.js 설정이 아직 되어 있지 않아 응답을 불러올 수 없습니다. README.md를 참고해 설정해 주세요.";
    $("a-go").disabled = true;
  }
  if (!$("a-from-d").value) $("a-from-d").value = toDateInput(startOfToday());
}
function closeAdmin() {
  currentHash = null; // 로그아웃
  $("pc-new").value = ""; $("pc-new2").value = ""; $("pc-box").open = false;
  $("pc-msg").textContent = "바꾸면 바로 로그아웃되고, 새 비밀번호로 다시 들어와야 합니다.";
  $("a-result").innerHTML = "";
  destroyCharts();
  lastRows = []; $("db-box").hidden = true; $("db-body").innerHTML = "";
  $("db-msg2").textContent = "조회 기간의 응답이 최근 순서로 나옵니다. 삭제한 응답은 되돌릴 수 없습니다.";
  if (cf.open) closeCf();
  document.querySelector("main.app").classList.remove("wide");
  views().forEach((v) => { v.hidden = v.id !== "view-home"; });
  window.scrollTo(0, 0);
  if (location.hash === "#admin") history.replaceState(null, "", location.pathname + location.search);
}
$("a-home").addEventListener("click", closeAdmin);
$("a-logout").addEventListener("click", closeAdmin);
if (location.hash === "#admin") askPassword();

/* ───────── 4. 기간 지정 → 응답 불러오기 ───────── */
function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
function pad(n) { return String(n).padStart(2, "0"); }
function toDateInput(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
// 날짜 칸(YYYY-MM-DD)과 시를 내 컴퓨터 시각으로 합침 (new Date("YYYY-MM-DD")는 세계 표준시로 읽혀서 쓰지 않음)
function joinDate(v, h, m, s, ms) {
  const p = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || "");
  return p ? new Date(+p[1], +p[2] - 1, +p[3], h, m, s, ms) : null;
}
function fmt(d) {
  return d.getFullYear() + ". " + (d.getMonth() + 1) + ". " + d.getDate() + ". " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

// 전체 기간을 고르면 날짜 칸을 잠금
$("a-all").addEventListener("change", () => {
  const on = $("a-all").checked;
  ["a-from-d", "a-from-h", "a-to-d", "a-to-h"].forEach((id) => { $(id).disabled = on; });
  $("a-from-d").required = !on;
});

let lastRows = [];   // 지금 화면에 나온 응답 (id 포함)
let lastLabel = "";  // 조회 기간 설명
async function loadRows() {
  if (!db) return;
  const m = $("a-msg");
  const all = $("a-all").checked;
  // 시작: 그 시 0분 0초부터 / 끝: 그 시 59분 59초까지 (끝 날짜를 비우면 지금까지)
  const from = all ? null : joinDate($("a-from-d").value, +$("a-from-h").value, 0, 0, 0);
  const to = all ? null : ($("a-to-d").value ? joinDate($("a-to-d").value, +$("a-to-h").value, 59, 59, 999) : new Date());
  if (!all && !from) { m.textContent = "시작 날짜를 입력해 주세요."; return; }
  if (!all && !to) { m.textContent = "끝 날짜를 다시 입력해 주세요."; return; }
  if (!all && to < from) { m.textContent = "끝 날짜와 시가 시작보다 앞설 수 없습니다."; return; }
  m.textContent = "응답을 불러오는 중입니다…";
  $("a-go").disabled = true;
  try {
    const q = all
      ? query(collection(db, COLLECTION), orderBy("createdAt"))
      : query(collection(db, COLLECTION),
          where("createdAt", ">=", Timestamp.fromDate(from)),
          where("createdAt", "<=", Timestamp.fromDate(to)),
          orderBy("createdAt"));
    const snap = await getDocs(q);
    lastRows = snap.docs.map((d) => norm({ id: d.id, ...d.data() }));
    lastLabel = all ? "전체 기간" : fmt(from) + " ~ " + fmt(to);
    m.textContent = lastLabel + " 사이 응답 " + lastRows.length + "건";
    if (all) m.textContent = "전체 기간 응답 " + lastRows.length + "건";
    renderAdmin(lastRows);
    renderList();
  } catch (err) {
    console.error("[firebase] 조회 실패", err);
    m.textContent = err && err.code === "permission-denied"
      ? "읽기 권한이 없습니다. 파이어베이스 콘솔에 firestore.rules를 게시했는지 확인해 주세요."
      : "응답을 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.";
  } finally {
    $("a-go").disabled = false;
  }
}
$("a-range").addEventListener("submit", (e) => { e.preventDefault(); loadRows(); });

// 응답 형식 맞추기: 지금 설문(testId "all", 31문항)과 예전 응답(testId "ov" 10문항 / "am" 21문항)을 같은 모양으로 다룸
// - r.ov = { answers, scores, total, level } 또는 null (과부하 부분이 없으면)
// - r.am = { answers, scores, qqsMean, qqsLevel, factors } 또는 null (동기/주의 부분이 없으면)
const N_OV = ALL.ov.items.length, N_AM = ALL.am.items.length;
function norm(r) {
  const A = Array.isArray(r.answers) ? r.answers : [], S = Array.isArray(r.scores) ? r.scores : [];
  r.ov = null; r.am = null;
  if (r.testId === "all" || r.testId === "ov") r.ov = { answers: A.slice(0, N_OV), scores: S.slice(0, N_OV), total: r.total, level: r.level };
  if (r.testId === "all") r.am = { answers: A.slice(N_OV), scores: S.slice(N_OV), qqsMean: r.qqsMean, qqsLevel: r.qqsLevel, factors: r.factors || {} };
  else if (r.testId === "am") r.am = { answers: A, scores: S, qqsMean: r.qqsMean, qqsLevel: r.qqsLevel, factors: r.factors || {} };
  return r;
}

/* ───────── 4-1. 응답 목록 관리 (개별·전체 삭제, xlsx 저장) ───────── */
function whenOf(r) { return r.createdAt && r.createdAt.toDate ? r.createdAt.toDate() : null; }
function stamp(d) {
  return d ? d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) : "";
}
function lvBadge(l) {
  const c = l === "위험" ? ["var(--hi)", "var(--hi-soft)"] : l === "양호" ? ["var(--lo)", "var(--lo-soft)"] : ["var(--mid)", "var(--mid-soft)"];
  return l ? '<span style="display:inline-block;padding:1px 9px;border-radius:99px;background:' + c[1] + ';color:' + c[0] + ';font-weight:700">' + esc(l) + "</span>" : "";
}
// 주의 저하 하위 요인 줄임말
const BO_SHORT = { bb: "지루함", bm: "의미", bg: "성장" };
function lvText(l) {
  const c = l === "위험" ? "var(--hi)" : l === "양호" ? "var(--lo)" : "var(--mid)";
  return '<span class="jd-lv" style="color:' + c + '">' + esc(l) + "</span>";
}
function renderList() {
  const box = $("db-box");
  box.hidden = false;
  const rows = lastRows.slice().reverse(); // 최근 응답이 위로
  $("db-count").textContent = lastLabel + " · " + rows.length + "건";
  $("db-xlsx").disabled = !rows.length;
  $("db-delall").disabled = !rows.length;
  if (!rows.length) { $("db-body").innerHTML = '<tr><td colspan="10" class="db-empty">이 기간에 저장된 응답이 없습니다.</td></tr>'; return; }
  const FB = ALL.am.factors.filter((f) => f.scale === "bo");
  $("db-body").innerHTML = rows.map((r, i) => {
    const age = ageOf(r);
    // 과부하: 합계 점수 + 판정 / 동기 저하: 종합 평균(2.06 기준) + 판정 / 주의 저하: 하위 요인 3개를 줄임말로 쉼표 구분
    const ovTd = r.ov ? r.ov.total + "점 " + lvBadge(r.ov.level) : '<span class="fine">-</span>';
    const qqTd = r.am && typeof r.am.qqsMean === "number" ? r.am.qqsMean.toFixed(2) + " " + lvBadge(r.am.qqsLevel) : '<span class="fine">-</span>';
    const boTd = r.am ? FB.map((f) => { const x = r.am.factors[f.id]; return esc(BO_SHORT[f.id]) + " " + (x ? lvText(x.level) : "-"); }).join(", ") : '<span class="fine">-</span>';
    // 입력 결과: 문항 순서대로 고른 보기 번호(1부터). 과부하 10개 | 동기·주의 21개
    const input = [r.ov ? r.ov.answers.map((a) => a + 1).join(", ") : "", r.am ? r.am.answers.map((a) => a + 1).join(", ") : ""].filter(Boolean).join(" | ");
    return "<tr><td class=\"n\">" + (rows.length - i) + "</td><td>" + esc(stamp(whenOf(r))) + "</td><td>" + esc(teamOf(r)) + "</td><td>" + esc(genderOf(r)) +
      "</td><td class=\"n\">" + (age === null ? "-" : age) + "</td><td class=\"jd\">" + ovTd + "</td><td class=\"jd\" style=\"white-space:nowrap\">" + qqTd + "</td><td class=\"jd\">" + boTd +
      "</td><td class=\"ans\">" + esc(input) + "</td><td class=\"c\"><button type=\"button\" class=\"del\" data-id=\"" + esc(r.id) + "\">삭제</button></td></tr>";
  }).join("");
}

// 삭제: 지금 비밀번호(해시 값)를 같은 묶음 쓰기에 함께 넣어야 보안 규칙이 허락함
async function deleteIds(ids) {
  const CHUNK = 400; // 묶음 쓰기 한 번에 500건까지라 나눠서 지움
  for (let i = 0; i < ids.length; i += CHUNK) {
    const batch = writeBatch(db);
    batch.set(doc(db, "adminAuth", "session"), { key: currentHash, at: serverTimestamp() });
    ids.slice(i, i + CHUNK).forEach((id) => batch.delete(doc(db, COLLECTION, id)));
    await batch.commit();
  }
}

// 삭제 확인 모달
const cf = $("cf-modal");
let cfAction = null, cfNeed = "";
function confirmDelete(text, need, action) {
  $("cf-text").textContent = text;
  cfNeed = need || "";
  $("cf-ask").hidden = !cfNeed;
  $("cf-ask-text").textContent = cfNeed ? "확인을 위해 '" + cfNeed + "'라고 입력해 주세요." : "";
  $("cf-input").value = "";
  $("cf-msg").textContent = "";
  $("cf-ok").disabled = false;
  cfAction = action;
  if (typeof cf.showModal === "function") cf.showModal(); else cf.setAttribute("open", "");
  (cfNeed ? $("cf-input") : $("cf-cancel")).focus();
}
function closeCf() { if (cf.open) cf.close(); else cf.removeAttribute("open"); cfAction = null; }
$("cf-cancel").addEventListener("click", closeCf);
$("cf-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (cfNeed && $("cf-input").value.trim() !== cfNeed) { $("cf-msg").textContent = "'" + cfNeed + "'라고 정확히 입력해 주세요."; return; }
  if (!cfAction) return;
  $("cf-ok").disabled = true;
  $("cf-msg").textContent = "삭제하는 중입니다…";
  try {
    await cfAction();
    closeCf();
  } catch (err) {
    console.error("[firebase] 삭제 실패", err);
    $("cf-msg").textContent = err && err.code === "permission-denied"
      ? "삭제 권한이 없습니다. 비밀번호가 다른 곳에서 바뀌었거나 firestore.rules가 게시되지 않았을 수 있습니다."
      : "삭제하지 못했습니다. 인터넷 연결을 확인해 주세요.";
    $("cf-ok").disabled = false;
  }
});

$("db-body").addEventListener("click", (e) => {
  const b = e.target.closest(".del"); if (!b) return;
  const id = b.getAttribute("data-id");
  const r = lastRows.find((x) => x.id === id); if (!r) return;
  const t = teamOf(r) + " · " + genderOf(r) + " · " + (ageOf(r) === null ? "-" : ageOf(r) + "세") + " · " + stamp(whenOf(r));
  confirmDelete("이 응답 1건을 삭제합니다.\n" + t + "\n삭제한 응답은 되돌릴 수 없습니다.", "", async () => {
    await deleteIds([id]);
    $("db-msg2").textContent = "응답 1건을 삭제했습니다.";
    await loadRows();
  });
});
$("db-delall").addEventListener("click", () => {
  const n = lastRows.length; if (!n) return;
  confirmDelete("지금 목록에 있는 응답 " + n + "건을 모두 삭제합니다. (" + lastLabel + ")\n삭제한 응답은 되돌릴 수 없습니다. 필요하면 먼저 엑셀(xlsx)로 저장해 두세요.", "전체 삭제", async () => {
    await deleteIds(lastRows.map((r) => r.id));
    $("db-msg2").textContent = "응답 " + n + "건을 삭제했습니다.";
    await loadRows();
  });
});

// xlsx 저장: 요약 시트 + 응답 시트(응답 한 건이 한 줄: 1부 과부하 10문항 + 2부 동기/주의 21문항)
const XLSX_URL = "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js";
function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((ok, no) => {
    const sc = document.createElement("script");
    sc.src = XLSX_URL;
    sc.onload = () => ok(window.XLSX);
    sc.onerror = () => no(new Error("xlsx 라이브러리를 불러오지 못했습니다."));
    document.head.appendChild(sc);
  });
}
function sheetAll(XLSX, rows) {
  const OV = ALL.ov, AM = ALL.am;
  const head = ["번호", "제출 시각", "조", "성별", "연령"];
  for (let k = 1; k <= N_OV; k++) head.push("과부하 " + k + "번 응답" + (OV.items[k - 1].rev ? "(역)" : ""));
  for (let k = 1; k <= N_OV; k++) head.push("과부하 " + k + "번 점수");
  head.push("과부하 합계", "과부하 판정");
  for (let k = 1; k <= N_AM; k++) head.push("동기·주의 " + k + "번 응답" + (AM.items[k - 1].rev ? "(역)" : ""));
  for (let k = 1; k <= N_AM; k++) head.push("동기·주의 " + k + "번 점수");
  AM.factors.forEach((f) => head.push(f.name + " 평균", f.name + " 판정"));
  head.push("동기 저하 종합 평균", "동기 저하 종합 판정", "주의 저하 평균(10~21번)");
  const blank = (n) => Array(n).fill("");
  const aoa = [head].concat(rows.map((r, i) => {
    let row = [i + 1, stamp(whenOf(r)), teamOf(r), genderOf(r), ageOf(r) === null ? "" : ageOf(r)];
    row = row.concat(r.ov ? r.ov.answers.map((a) => OV.options[a]) : blank(N_OV))
      .concat(r.ov ? r.ov.scores : blank(N_OV))
      .concat(r.ov ? [r.ov.total, r.ov.level] : ["", ""])
      .concat(r.am ? r.am.answers.map((a) => (a + 1) + ". " + AM.options[a]) : blank(N_AM))
      .concat(r.am ? r.am.scores : blank(N_AM));
    AM.factors.forEach((f) => { const x = r.am && r.am.factors[f.id]; row.push(x ? x.mean : "", x ? x.level : ""); });
    const at = r.am ? attnMean(r) : NaN;
    row.push(r.am ? r.am.qqsMean : "", r.am ? r.am.qqsLevel : "", isFinite(at) ? Number(fnum(at, 3)) : "");
    return row;
  }));
  return XLSX.utils.aoa_to_sheet(aoa);
}
$("db-xlsx").addEventListener("click", async () => {
  const m = $("db-msg2");
  if (!lastRows.length) return;
  m.textContent = "엑셀 파일을 만드는 중입니다…";
  try {
    const XLSX = await loadXlsx();
    const wb = XLSX.utils.book_new();
    const teamRows = (t) => lastRows.filter((r) => teamOf(r) === t);
    const info = XLSX.utils.aoa_to_sheet([["위험감수성 측정 설문 응답"], ["조회 기간", lastLabel], ["내려받은 시각", stamp(new Date())],
      ["전체 응답", lastRows.length], ["과부하 민감도 응답", lastRows.filter((r) => r.ov).length], ["동기/주의 저하 응답", lastRows.filter((r) => r.am).length], []]
      .concat([["조", "응답", "여성", "남성", "평균 연령", "과부하 평균", "동기 저하 평균", "주의 저하 평균"]])
      .concat(["1조", "2조", "미입력"].map((t) => {
        const g = teamRows(t), ages = g.map(ageOf).filter((a) => a !== null);
        const nums = (a) => a.filter((v) => typeof v === "number" && isFinite(v));
        const ovSc = nums(g.filter((r) => r.ov).map((r) => r.ov.total)), qq = nums(g.filter((r) => r.am).map((r) => r.am.qqsMean)), at = nums(g.filter((r) => r.am).map(attnMean));
        return [t, g.length, g.filter((r) => genderOf(r) === "여성").length, g.filter((r) => genderOf(r) === "남성").length,
          ages.length ? Number(fnum(avg(ages), 1)) : "", ovSc.length ? Number(fnum(avg(ovSc), 1)) : "", qq.length ? Number(fnum(avg(qq), 2)) : "", at.length ? Number(fnum(avg(at), 2)) : ""];
      }).filter((row) => row[0] !== "미입력" || row[1] > 0)));
    info["!cols"] = [{ wch: 22 }, { wch: 40 }];
    XLSX.utils.book_append_sheet(wb, info, "요약");
    const s1 = sheetAll(XLSX, lastRows); s1["!cols"] = [{ wch: 6 }, { wch: 20 }, { wch: 6 }, { wch: 6 }, { wch: 6 }]; XLSX.utils.book_append_sheet(wb, s1, "응답");
    const d = new Date();
    // 일부 브라우저에서 한글 파일 이름이 "download"로 바뀌는 경우가 있어 영문 이름을 씀 (시트 이름과 내용은 한글)
    const name = "RiskSurvey_Responses_" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "_" + pad(d.getHours()) + pad(d.getMinutes()) + ".xlsx";
    // 파일 이름이 그대로 쓰이도록 직접 내려받기 링크를 만들어 누름
    const blob = new Blob([XLSX.write(wb, { bookType: "xlsx", type: "array" })],
      { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = name; document.body.appendChild(link); link.click();
    setTimeout(() => { document.body.removeChild(link); URL.revokeObjectURL(url); }, 1000);
    m.textContent = "엑셀 파일(" + name + ")을 내려받았습니다.";
  } catch (err) {
    console.error("[xlsx] 저장 실패", err);
    m.textContent = "엑셀 파일을 만들지 못했습니다. 인터넷 연결을 확인해 주세요.";
  }
});

/* ───────── 5. 그래프 ───────── */
function destroyCharts() { charts.forEach((c) => c.destroy()); charts = []; }
// 그래프 색은 관리자 화면(#view-admin)에 정한 색을 읽음
function css(name) { return getComputedStyle($("view-admin")).getPropertyValue(name).trim(); }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c])); }
const LV = ["양호", "주의", "위험"];
const lvColors = () => [css("--lo"), css("--mid"), css("--hi")];
const avg = (a) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const pct = (n, t) => t ? Math.round(n / t * 1000) / 10 : 0;
function countLv(list) { return LV.map((l) => list.filter((v) => v === l).length); }

function baseOpts(extra) {
  const ink = css("--muted"), grid = css("--line");
  return Object.assign({
    responsive: true, maintainAspectRatio: false, animation: false,
    plugins: { legend: { display: false }, tooltip: { titleFont: { family: FONT }, bodyFont: { family: FONT } } },
    scales: {
      x: { ticks: { color: ink, font: { family: FONT } }, grid: { color: grid } },
      y: { ticks: { color: ink, font: { family: FONT }, precision: 0 }, grid: { color: grid }, beginAtZero: true }
    }
  }, extra || {});
}
function make(id, cfg, plugins) {
  if (plugins) cfg.plugins = plugins;
  const el = $(id);
  if (!el || !window.Chart) return;
  window.Chart.defaults.font.family = FONT;
  charts.push(new window.Chart(el, cfg));
}
// 막대 위 툴팁: "n명 (p%)"
const countTip = (total) => ({ callbacks: { label: (c) => " " + c.parsed.y + "명 (" + pct(c.parsed.y, total) + "%)" } });

/* 응답자 정보(조·성별·연령) 읽기. 예전 응답(정보 없음)은 "미입력"으로 묶음 */
const TEAMS = ["1조", "2조"];
const GENDERS = ["여성", "남성"];
const teamOf = (r) => TEAMS.includes(r.team) ? r.team : "미입력";
const genderOf = (r) => GENDERS.includes(r.gender) ? r.gender : "미입력";
const ageOf = (r) => (typeof r.age === "number" && isFinite(r.age)) ? r.age : null;
// 연령대 구간: 20대 이하 / 30대 / 40대 / 50대 / 60대 이상
const AGE_BINS = [
  { label: "20대 이하", lo: 0, hi: 29 }, { label: "30대", lo: 30, hi: 39 }, { label: "40대", lo: 40, hi: 49 },
  { label: "50대", lo: 50, hi: 59 }, { label: "60대 이상", lo: 60, hi: 999 }];
const ageBinOf = (a) => a === null ? "미입력" : AGE_BINS.find((b) => a >= b.lo && a <= b.hi).label;

// 반올림: 2.555 같은 값이 2.55로 내려가지 않도록 10진 지수로 반올림한 뒤 자릿수를 맞춤
const fnum = (v, d) => { v = Number(v.toFixed(10)); return Number(Math.round(Number(v + "e" + d)) + "e-" + d).toFixed(d); };
// 요약 칸: 큰 글씨 "평균 점수" / 작은 글씨 최소 ~ 최대 (건수는 앞의 응답 칸에 있으므로 되풀이하지 않음)
function sumBox(label, note, n, sc, digits, avgDigits) {
  const body = sc.length
    ? '<dd><span class="a-n">평균 </span>' + fnum(avg(sc), avgDigits) + '점</dd><dd class="a-rng">최소 ' + fnum(Math.min(...sc), digits) + ' ~ 최대 ' + fnum(Math.max(...sc), digits) + '</dd>'
    : '<dd>-</dd><dd class="a-rng">응답 없음</dd>';
  return '<div><dt>' + esc(label) + (note ? '<span class="fine">' + esc(note) + '</span>' : '') + '</dt>' + body + '</div>';
}
// 분석별 요약 줄(응답 건수 + 과부하·동기 저하·주의 저하 평균)
function sumRow(rows, firstLabel) {
  const ov = rows.filter((r) => r.ov), am = rows.filter((r) => r.am);
  // - 과부하 민감도: 1부 합계 점수(10~40점)
  // - 동기 저하: 2부 1~9번 종합 평균(qqsMean, 1~5점)
  // - 주의 저하: 2부 10~21번 평균(1~5점, 역문항은 바꾼 점수). 종합 판정은 없지만 평균은 문항 점수로 계산
  const nums = (a) => a.filter((v) => typeof v === "number" && isFinite(v));
  return '<dl class="a-sum"><div><dt>' + esc(firstLabel) + '</dt><dd>' + rows.length + '건</dd></div>' +
    sumBox("과부하 민감도", ALL.ov.max + "점 만점", ov.length, nums(ov.map((r) => r.ov.total)), 0, 1) +
    sumBox("동기 저하", "5점 만점", am.length, nums(am.map((r) => r.am.qqsMean)), 2, 2) +
    sumBox("주의 저하", "5점 만점", am.length, nums(am.map(attnMean)), 2, 2) + '</dl>';
}

// 한 조의 결과를 칸(열 머리, 응답자 구성, 과부하 민감도, 동기 저하, 주의 저하)으로 나눠 돌려줌. 그래프 canvas에는 조 번호 접미사 k를 붙여 구분
function teamCells(rows, label, k) {
  const ov = rows.filter((r) => r.ov), am = rows.filter((r) => r.am);
  const ages = rows.map(ageOf).filter((a) => a !== null);
  const gF = rows.filter((r) => genderOf(r) === "여성").length, gM = rows.filter((r) => genderOf(r) === "남성").length;
  const cls = "c" + k;
  // 열 머리(스크롤해도 위에 붙어 있음): 조 이름만 (응답 수·성별·연령은 바로 아래 응답자 구성 카드에 있으므로 겹쳐 쓰지 않음)
  const head = '<div class="a-th ' + cls + '"><b>' + esc(label) + '</b></div>';
  // 성별·연령 요약과 분포 그래프 + 이 조의 분석별 요약
  const demo = '<div class="card a-demo ' + cls + '"><strong>응답자 구성 <span class="fine" style="font-weight:400">(성별 · 연령)</span></strong>' +
    '<dl class="a-sum"><div><dt>응답</dt><dd>' + rows.length + '명</dd></div>' +
    '<div><dt>여성</dt><dd>' + gF + '명<span class="a-n">(' + pct(gF, rows.length) + '%)</span></dd></div>' +
    '<div><dt>남성</dt><dd>' + gM + '명<span class="a-n">(' + pct(gM, rows.length) + '%)</span></dd></div>' +
    (ages.length
      ? '<div><dt>연령</dt><dd><span class="a-n">평균 </span>' + fnum(avg(ages), 1) + '세</dd><dd class="a-rng">최소 ' + Math.min(...ages) + ' ~ 최대 ' + Math.max(...ages) + '세</dd></div>'
      : '<div><dt>연령</dt><dd>-</dd><dd class="a-rng">입력 없음</dd></div>') + '</dl>' +
    '<div class="a-charts"><div><p class="a-sub">성별 분포</p><div class="chart-box sm"><canvas id="c-gd-' + k + '"></canvas></div></div>' +
    '<div><p class="a-sub">연령대 분포</p><div class="chart-box sm"><canvas id="c-ag-' + k + '"></canvas></div></div></div>' +
    (rows.length ? sumRow(rows, "응답") : "") + '</div>';

  // 과부하 민감도 (1부)
  let ovH = '<div class="card ' + cls + '"><strong>과부하 민감도</strong>';
  if (!ov.length) ovH += '<p class="fine">이 기간에 응답이 없습니다.</p>';
  else {
    ovH += '<span class="printnote" style="text-align:left">응답 ' + ov.length + '명 · 평균 ' + avg(ov.map((r) => r.ov.total)).toFixed(1) + '점 / ' + ALL.ov.max + '점 (낮을수록 좋음)</span>' +
      '<p class="a-sub">판정 분포</p><div class="chart-box"><canvas id="c-ov-lv-' + k + '"></canvas></div>' +
      '<p class="a-sub">점수 분포</p><div class="chart-box"><canvas id="c-ov-sc-' + k + '"></canvas></div>' +
      '<p class="a-sub">문항별 응답 분포 <span class="fine">(4점일수록 민감 · *는 역문항)</span></p><div class="chart-box xtall"><canvas id="c-ov-it-' + k + '"></canvas></div>';
  }
  ovH += '</div>';

  // 동기 저하 (2부 1~9번, 조용한 퇴사)
  let qqH = '<div class="card ' + cls + '"><strong>동기 저하</strong>';
  if (!am.length) qqH += '<p class="fine">이 기간에 응답이 없습니다.</p>';
  else {
    qqH += '<span class="printnote" style="text-align:left">응답 ' + am.length + '명 · 종합 평균 ' + avg(am.map((r) => r.am.qqsMean)).toFixed(2) + ' (기준 ' + ALL.am.qqs_cut + ' 미만이 양호)</span>' +
      '<p class="a-sub">종합 판정 분포</p><div class="chart-box"><canvas id="c-am-lv-' + k + '"></canvas></div>' +
      '<p class="a-sub">하위 요인별 판정 비율</p><div class="chart-box sm"><canvas id="c-am-fl-q-' + k + '"></canvas></div>';
  }
  qqH += '</div>';

  // 주의 저하 (2부 10~21번, 보어아웃)
  let boH = '<div class="card ' + cls + '"><strong>주의 저하</strong>';
  if (!am.length) boH += '<p class="fine">이 기간에 응답이 없습니다.</p>';
  else {
    const at = am.map(attnMean).filter((v) => isFinite(v));
    boH += '<span class="printnote" style="text-align:left">응답 ' + am.length + '명 · 평균 ' + (at.length ? avg(at).toFixed(2) : "-") + ' / 5점 (낮을수록 좋음)</span>' +
      '<p class="a-sub">하위 요인별 판정 비율</p><div class="chart-box sm"><canvas id="c-am-fl-b-' + k + '"></canvas></div>';
  }
  boH += '</div>';
  return { head, demo, ov: ovH, qq: qqH, bo: boH };
}

function renderAdmin(rows) {
  destroyCharts();
  // 맨 위: 전체 요약(조 구분 없음) → 아래: 1조, 2조 (예전 응답처럼 조가 없는 것은 "조 미입력"으로 따로)
  // - 조가 입력된 응답이 하나라도 있으면 1조·2조 묶음을 모두 보여 줌 (한쪽이 0건이어도 "응답이 없습니다"로 표시)
  // - 조가 입력된 응답이 하나도 없으면(예전 응답만 있거나 응답이 없으면) 1조·2조 묶음은 숨기고 "조 미입력"만 보여 줌
  const none = rows.filter((r) => teamOf(r) === "미입력");
  const hasTeam = rows.length > none.length;
  const groups = hasTeam ? TEAMS.map((t) => ({ label: t, rows: rows.filter((r) => teamOf(r) === t) })) : [];
  if (none.length) groups.push({ label: "조 미입력", rows: none });
  // 조를 가로로 나란히 놓고, 같은 종류의 칸(응답자 구성 / 과부하 / 동기 저하 / 주의 저하)을 같은 줄에 맞춤
  let html = '<section class="a-total"><p class="a-tt">전체 합계 <span class="fine">조 구분 없이 조회 기간의 모든 응답</span></p>' + sumRow(rows, "전체 응답") + '</section>';
  if (groups.length) {
    const cells = groups.map((g, k) => teamCells(g.rows, g.label, k));
    const row = (title, key) => '<p class="a-rowt">' + title + '</p>' + cells.map((c) => c[key]).join("");
    html += '<div class="a-cmp" style="--cols:' + groups.length + '">' + cells.map((c) => c.head).join("") +
      row("응답자 구성", "demo") + row("① 과부하 민감도", "ov") + row("② 동기 저하", "qq") + row("③ 주의 저하", "bo") + '</div>';
  }
  $("a-result").innerHTML = html;

  const colors = lvColors();
  // 세로 막대(판정 분포·점수 분포): 막대 위에 "인원(%)" 표시
  const countBar = (id, labels, counts, bg, total) => make(id, { type: "bar",
    data: { labels, datasets: [{ data: counts, backgroundColor: bg, borderRadius: 6 }] },
    options: baseOpts({
      plugins: { legend: { display: false }, tooltip: countTip(total), valueLabels: { mode: "top", total } },
      scales: {
        x: { ticks: { color: css("--muted"), font: { family: FONT } }, grid: { color: css("--line") } },
        y: { beginAtZero: true, grace: "22%", ticks: { color: css("--muted"), font: { family: FONT }, precision: 0 }, grid: { color: css("--line") } }
      } }) }, [valueLabels]);
  // 가로 100% 누적 막대(비율 비교): 조각 안에 "인원(%)" 표시. series = [{ label, color, ink, counts[] }]
  const ratioBar = (id, labels, series, total) => make(id, { type: "bar",
    data: { labels, datasets: series.map((x) => ({ label: x.label, backgroundColor: x.color, ink: x.ink || "#fff",
      counts: x.counts, data: x.counts.map((n) => pct(n, total)) })) },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: true, position: "bottom", labels: { color: css("--muted"), font: { family: FONT } } },
        tooltip: { callbacks: { label: (c) => " " + c.dataset.label + " " + c.dataset.counts[c.dataIndex] + "명 (" + c.parsed.x + "%)" } },
        valueLabels: { mode: "inside", total } },
      scales: {
        x: { stacked: true, min: 0, max: 100, ticks: { color: css("--muted"), font: { family: FONT }, callback: (v) => v + "%" }, grid: { color: css("--line") } },
        y: { stacked: true, ticks: { color: css("--muted"), font: { family: FONT }, autoSkip: false }, grid: { display: false } }
      } } }, [valueLabels]);

  groups.forEach((g, k) => {
    const ov = g.rows.filter((r) => r.ov), am = g.rows.filter((r) => r.am);
    // 응답자 구성: 성별(여성·남성·미입력은 있을 때만), 연령대
    const gLabels = GENDERS.slice(), gCounts = GENDERS.map((x) => g.rows.filter((r) => genderOf(r) === x).length);
    const gNone = g.rows.filter((r) => genderOf(r) === "미입력").length;
    if (gNone) { gLabels.push("미입력"); gCounts.push(gNone); }
    countBar("c-gd-" + k, gLabels, gCounts, [css("--c-am"), css("--c-ov"), css("--muted")], g.rows.length);
    const aLabels = AGE_BINS.map((b) => b.label), aCounts = AGE_BINS.map((b) => g.rows.filter((r) => ageBinOf(ageOf(r)) === b.label).length);
    const aNone = g.rows.filter((r) => ageOf(r) === null).length;
    if (aNone) { aLabels.push("미입력"); aCounts.push(aNone); }
    countBar("c-ag-" + k, aLabels, aCounts, aLabels.map((l) => l === "미입력" ? css("--muted") : css("--accent")), g.rows.length);

    if (ov.length) {
      countBar("c-ov-lv-" + k, LV, countLv(ov.map((r) => r.ov.level)), colors, ov.length);
      // 점수 구간: 판정 기준(16점, 26점)에 맞춰 나눔
      const bins = [[10, 15], [16, 20], [21, 25], [26, 30], [31, 35], [36, 40]];
      countBar("c-ov-sc-" + k, bins.map((b) => b[0] + "~" + b[1] + "점"), bins.map((b) => ov.filter((r) => r.ov.total >= b[0] && r.ov.total <= b[1]).length),
        bins.map((b) => b[1] <= 15 ? colors[0] : b[1] <= 25 ? colors[1] : colors[2]), ov.length);
      // 문항별 응답 분포: 점수(1~4점) 기준이라 역문항도 같은 방향(4점 = 민감)으로 비교됨
      const SC = [
        { s: 4, label: "4점 (민감)", color: colors[2] },
        { s: 3, label: "3점", color: colors[1] },
        { s: 2, label: "2점", color: "#9ED9AB", ink: "#17211F" },
        { s: 1, label: "1점 (둔감)", color: colors[0] }];
      ratioBar("c-ov-it-" + k, ALL.ov.items.map((it, i) => (i + 1) + (it.rev ? "*" : "") + ". " + short(it.t)),
        SC.map((x) => ({ label: x.label, color: x.color, ink: x.ink, counts: ALL.ov.items.map((_, i) => ov.filter((r) => r.ov.scores[i] === x.s).length) })), ov.length);
    }
    if (am.length) {
      countBar("c-am-lv-" + k, LV, countLv(am.map((r) => r.am.qqsLevel)), colors, am.length);
      // 하위 요인별 판정 비율: 동기 저하·주의 저하를 따로 그림
      const lvSeries = (F) => LV.map((l, i) => ({ label: l, color: colors[i], counts: F.map((f) => am.filter((r) => r.am.factors[f.id] && r.am.factors[f.id].level === l).length) }));
      const FQ = ALL.am.factors.filter((f) => f.scale === "qqs"), FB = ALL.am.factors.filter((f) => f.scale === "bo");
      ratioBar("c-am-fl-q-" + k, FQ.map((f) => f.name), lvSeries(FQ), am.length);
      ratioBar("c-am-fl-b-" + k, FB.map((f) => f.name), lvSeries(FB), am.length);
    }
  });
}

// 막대에 "인원(%)" 글자를 그리는 Chart.js 플러그인
// - top: 세로 막대 위 / inside: 가로 누적 막대 조각 안 (자리가 모자라면 "%"만, 그래도 모자라면 생략 → 마우스를 올리면 보임)
const valueLabels = {
  id: "valueLabels",
  afterDatasetsDraw(chart) {
    const o = chart.options.plugins.valueLabels;
    if (!o || !o.mode) return;
    const ctx = chart.ctx;
    ctx.save();
    ctx.font = "700 12px " + FONT;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    chart.data.datasets.forEach((ds, di) => {
      const meta = chart.getDatasetMeta(di);
      if (meta.hidden) return;
      meta.data.forEach((el, i) => {
        const n = ds.counts ? ds.counts[i] : ds.data[i];
        if (!n) return;
        const p = ds.counts ? ds.data[i] : pct(n, o.total);
        const full = n + "명 (" + p + "%)";
        const a = n + "명", b = "(" + p + "%)";
        if (o.mode === "top") {
          // 막대 폭보다 길면 "인원" / "(%)" 두 줄로
          ctx.fillStyle = css("--ink");
          if (ctx.measureText(full).width + 4 <= (el.width || 40)) ctx.fillText(full, el.x, el.y - 11);
          else { ctx.fillText(a, el.x, el.y - 25); ctx.fillText(b, el.x, el.y - 11); }
          return;
        }
        // 조각 안: 한 줄 → 두 줄("인원" / "%") → "%"만 → 생략 순서로 맞춤
        const w = Math.abs(el.x - el.base) - 6, h = el.height || 20, cx = (el.x + el.base) / 2;
        ctx.fillStyle = ds.ink || "#fff";
        if (h < 14) return;
        if (ctx.measureText(full).width <= w) ctx.fillText(full, cx, el.y);
        else if (h >= 28 && Math.max(ctx.measureText(a).width, ctx.measureText(p + "%").width) <= w) {
          ctx.fillText(a, cx, el.y - 7); ctx.fillText(p + "%", cx, el.y + 7);
        } else if (ctx.measureText(p + "%").width <= w) ctx.fillText(p + "%", cx, el.y);
      });
    });
    ctx.restore();
  }
};

// 주의 저하(2부 10~21번) 평균: 문항 점수가 있으면 그것으로, 없으면 하위 요인 3개(각 4문항) 평균의 평균으로 계산
function attnMean(r) {
  const am = r.am; if (!am) return NaN;
  if (Array.isArray(am.scores) && am.scores.length >= N_AM) {
    const a = am.scores.slice(9, N_AM).map(Number);
    if (a.every((v) => isFinite(v))) return a.reduce((s, v) => s + v, 0) / a.length;
  }
  const F = ALL.am.factors.filter((f) => f.scale === "bo").map((f) => am.factors[f.id] && am.factors[f.id].mean);
  return F.every((v) => typeof v === "number") ? F.reduce((s, v) => s + v, 0) / F.length : NaN;
}

function short(t) { return t.length > 16 ? t.slice(0, 16) + "…" : t; }
