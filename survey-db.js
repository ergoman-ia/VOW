// 설문 응답 저장(파이어베이스 Firestore)과 관리자 모드(비밀번호 확인 → 기간별 결과 그래프)
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
  views().forEach((v) => { v.hidden = v.id !== "view-admin"; });
  window.scrollTo(0, 0);
  if (!db) {
    $("a-msg").textContent = "firebase-config.js 설정이 아직 되어 있지 않아 응답을 불러올 수 없습니다. README.md를 참고해 설정해 주세요.";
    $("a-go").disabled = true;
  }
  if (!$("a-from").value) $("a-from").value = toLocalInput(startOfToday());
}
function closeAdmin() {
  currentHash = null; // 로그아웃
  $("pc-new").value = ""; $("pc-new2").value = ""; $("pc-box").open = false;
  $("pc-msg").textContent = "바꾸면 바로 로그아웃되고, 새 비밀번호로 다시 들어와야 합니다.";
  $("a-result").innerHTML = "";
  destroyCharts();
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
function toLocalInput(d) {
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
}
function fmt(d) {
  return d.getFullYear() + ". " + (d.getMonth() + 1) + ". " + d.getDate() + ". " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

$("a-range").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!db) return;
  const m = $("a-msg");
  const from = new Date($("a-from").value);
  const to = $("a-to").value ? new Date($("a-to").value) : new Date();
  if (isNaN(from.getTime())) { m.textContent = "시작 날짜와 시간을 입력해 주세요."; return; }
  if (to < from) { m.textContent = "끝 날짜와 시간이 시작보다 앞설 수 없습니다."; return; }
  m.textContent = "응답을 불러오는 중입니다…";
  $("a-go").disabled = true;
  try {
    const q = query(collection(db, COLLECTION),
      where("createdAt", ">=", Timestamp.fromDate(from)),
      where("createdAt", "<=", Timestamp.fromDate(to)),
      orderBy("createdAt"));
    const snap = await getDocs(q);
    const rows = snap.docs.map((d) => d.data());
    m.textContent = fmt(from) + " ~ " + fmt(to) + " 사이 응답 " + rows.length + "건";
    renderAdmin(rows);
  } catch (err) {
    console.error("[firebase] 조회 실패", err);
    m.textContent = err && err.code === "permission-denied"
      ? "읽기 권한이 없습니다. 파이어베이스 콘솔에 firestore.rules를 게시했는지 확인해 주세요."
      : "응답을 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.";
  } finally {
    $("a-go").disabled = false;
  }
});

/* ───────── 5. 그래프 ───────── */
function destroyCharts() { charts.forEach((c) => c.destroy()); charts = []; }
function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
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
function make(id, cfg) {
  const el = $(id);
  if (!el || !window.Chart) return;
  window.Chart.defaults.font.family = FONT;
  charts.push(new window.Chart(el, cfg));
}
// 막대 위 툴팁: "n명 (p%)"
const countTip = (total) => ({ callbacks: { label: (c) => " " + c.parsed.y + "명 (" + pct(c.parsed.y, total) + "%)" } });

function renderAdmin(rows) {
  destroyCharts();
  const ov = rows.filter((r) => r.testId === "ov");
  const am = rows.filter((r) => r.testId === "am");
  let html = '<dl class="a-sum"><div><dt>전체 응답</dt><dd>' + rows.length + '</dd></div>' +
    '<div><dt>' + esc(ALL.ov.title) + '</dt><dd>' + ov.length + '</dd></div>' +
    '<div><dt>' + esc(ALL.am.title) + '</dt><dd>' + am.length + '</dd></div></dl>';

  // 과부하 민감도
  html += '<div class="card"><strong>' + esc(ALL.ov.title) + '</strong>';
  if (!ov.length) html += '<p class="fine">이 기간에 응답이 없습니다.</p>';
  else {
    html += '<span class="printnote" style="text-align:left">응답 ' + ov.length + '명 · 평균 ' + avg(ov.map((r) => r.total)).toFixed(1) + '점 / ' + ALL.ov.max + '점 (낮을수록 좋음)</span>' +
      '<p class="a-sub">판정 분포</p><div class="chart-box"><canvas id="c-ov-lv"></canvas></div>' +
      '<p class="a-sub">점수 분포</p><div class="chart-box"><canvas id="c-ov-sc"></canvas></div>' +
      '<p class="a-sub">문항별 평균 점수 <span class="fine">(1~4점, 역문항은 바꾼 점수)</span></p><div class="chart-box tall"><canvas id="c-ov-it"></canvas></div>';
  }
  html += '</div>';

  // 동기/주의 저하
  html += '<div class="card"><strong>' + esc(ALL.am.title) + '</strong>';
  if (!am.length) html += '<p class="fine">이 기간에 응답이 없습니다.</p>';
  else {
    html += '<span class="printnote" style="text-align:left">응답 ' + am.length + '명 · 동기 저하 종합 평균 ' + avg(am.map((r) => r.qqsMean)).toFixed(2) + ' (기준 ' + ALL.am.qqs_cut + ' 미만이 양호)</span>' +
      '<p class="a-sub">동기 저하 종합 판정 분포</p><div class="chart-box"><canvas id="c-am-lv"></canvas></div>' +
      '<p class="a-sub">하위 요인별 평균 점수 <span class="fine">(1~5점)</span></p><div class="chart-box"><canvas id="c-am-fm"></canvas></div>' +
      '<p class="a-sub">하위 요인별 판정 비율</p><div class="chart-box tall"><canvas id="c-am-fl"></canvas></div>';
  }
  html += '</div>';
  $("a-result").innerHTML = html;

  const colors = lvColors();
  if (ov.length) {
    make("c-ov-lv", { type: "bar",
      data: { labels: LV, datasets: [{ data: countLv(ov.map((r) => r.level)), backgroundColor: colors, borderRadius: 6 }] },
      options: baseOpts({ plugins: { legend: { display: false }, tooltip: countTip(ov.length) } }) });
    // 점수 구간: 판정 기준(16점, 26점)에 맞춰 나눔
    const bins = [[10, 15], [16, 20], [21, 25], [26, 30], [31, 35], [36, 40]];
    make("c-ov-sc", { type: "bar",
      data: { labels: bins.map((b) => b[0] + "~" + b[1] + "점"),
        datasets: [{ data: bins.map((b) => ov.filter((r) => r.total >= b[0] && r.total <= b[1]).length),
          backgroundColor: bins.map((b) => b[1] <= 15 ? colors[0] : b[1] <= 25 ? colors[1] : colors[2]), borderRadius: 6 }] },
      options: baseOpts({ plugins: { legend: { display: false }, tooltip: countTip(ov.length) } }) });
    const itemMeans = ALL.ov.items.map((_, k) => avg(ov.map((r) => r.scores[k])));
    make("c-ov-it", { type: "bar",
      data: { labels: ALL.ov.items.map((it, k) => (k + 1) + (it.rev ? "*" : "") + ". " + short(it.t)),
        datasets: [{ data: itemMeans.map((v) => Math.round(v * 100) / 100), backgroundColor: css("--c-ov"), borderRadius: 4 }] },
      options: horiz(0, 4, (c) => " 평균 " + c.parsed.x.toFixed(2) + "점") });
  }
  if (am.length) {
    make("c-am-lv", { type: "bar",
      data: { labels: LV, datasets: [{ data: countLv(am.map((r) => r.qqsLevel)), backgroundColor: colors, borderRadius: 6 }] },
      options: baseOpts({ plugins: { legend: { display: false }, tooltip: countTip(am.length) } }) });
    const F = ALL.am.factors;
    make("c-am-fm", { type: "bar",
      data: { labels: F.map((f) => f.name),
        datasets: [{ data: F.map((f) => Math.round(avg(am.map((r) => r.factors[f.id].mean)) * 100) / 100),
          backgroundColor: F.map((f) => f.scale === "qqs" ? css("--c-am") : css("--c-ov")), borderRadius: 6 }] },
      options: baseOpts({
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => " 평균 " + c.parsed.y.toFixed(2) + "점" } } },
        scales: {
          x: { ticks: { color: css("--muted"), font: { family: FONT }, autoSkip: false, maxRotation: 45, minRotation: 0 }, grid: { display: false } },
          y: { min: 0, max: 5, ticks: { color: css("--muted"), font: { family: FONT }, stepSize: 1 }, grid: { color: css("--line") } }
        } }) });
    make("c-am-fl", { type: "bar",
      data: { labels: F.map((f) => f.name),
        datasets: LV.map((l, i) => ({ label: l, backgroundColor: colors[i],
          data: F.map((f) => pct(am.filter((r) => r.factors[f.id].level === l).length, am.length)) })) },
      options: {
        indexAxis: "y", responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: true, position: "bottom", labels: { color: css("--muted"), font: { family: FONT } } },
          tooltip: { callbacks: { label: (c) => " " + c.dataset.label + " " + c.parsed.x + "%" } } },
        scales: {
          x: { stacked: true, min: 0, max: 100, ticks: { color: css("--muted"), font: { family: FONT }, callback: (v) => v + "%" }, grid: { color: css("--line") } },
          y: { stacked: true, ticks: { color: css("--muted"), font: { family: FONT } }, grid: { display: false } }
        } } });
  }
}
function short(t) { return t.length > 9 ? t.slice(0, 9) + "…" : t; }
function horiz(min, max, label) {
  return {
    indexAxis: "y", responsive: true, maintainAspectRatio: false, animation: false,
    plugins: { legend: { display: false }, tooltip: { callbacks: { label } } },
    scales: {
      x: { min, max, ticks: { color: css("--muted"), font: { family: FONT }, stepSize: 1 }, grid: { color: css("--line") } },
      y: { ticks: { color: css("--muted"), font: { family: FONT }, autoSkip: false }, grid: { display: false } }
    }
  };
}
