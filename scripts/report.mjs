// 어제와 오늘 순위를 비교해 텔레그램으로 아침 리포트를 보낸다.
// 사용: TELEGRAM_BOT_TOKEN=… TELEGRAM_CHAT_ID=… node scripts/report.mjs [--dry]
import fs from "node:fs";

const ROOT = new URL("../", import.meta.url).pathname;
const DATA = `${ROOT}data`;
const DRY = process.argv.includes("--dry");

const readJson = (path) => JSON.parse(fs.readFileSync(path, "utf8"));
const { dates } = readJson(`${DATA}/index.json`);
const apps = readJson(`${DATA}/apps.json`);
const today = readJson(`${DATA}/snapshots/${dates.at(-1)}.json`);
const yesterday = dates.length > 1 ? readJson(`${DATA}/snapshots/${dates.at(-2)}.json`) : null;

const name = (id) => {
  const a = apps[id];
  if (!a) return id;
  return a.name.length > 22 ? `${a.name.slice(0, 21)}…` : a.name;
};
const rankMap = (list) => new Map(list.map((id, i) => [id, i + 1]));

/** 한 차트에서 새로 들어온 앱과 크게 오른 앱 */
function movers(key, top = 50, minGain = 15) {
  const now = today.charts[key] ?? [];
  const before = rankMap(yesterday?.charts[key] ?? []);
  const fresh = [];
  const risers = [];
  now.forEach((id, i) => {
    const rank = i + 1;
    if (rank > top) return;
    const prev = before.get(id);
    if (prev === undefined) fresh.push({ id, rank });
    else if (prev - rank >= minGain) risers.push({ id, rank, gain: prev - rank });
  });
  risers.sort((a, b) => b.gain - a.gain);
  return { fresh, risers };
}

/** 하루 새 리뷰(평가) 수가 크게 늘어난 앱 */
function reviewSurge(limit = 5) {
  if (!yesterday) return [];
  return Object.entries(today.ratings)
    .map(([id, count]) => ({ id, added: count - (yesterday.ratings[id] ?? count) }))
    .filter((r) => r.added >= 200)
    .sort((a, b) => b.added - a.added)
    .slice(0, limit);
}

const LABELS = {
  "kr/free": "🇰🇷 무료",
  "kr/grossing": "🇰🇷 매출",
  "kr/paid": "🇰🇷 유료",
  "us/free": "🇺🇸 무료",
  "us/grossing": "🇺🇸 매출",
};

const lines = [`📈 앱 트렌드 ${today.date}`];
if (!yesterday) {
  lines.push("", "첫 수집이라 비교할 어제 데이터가 없어요. 내일부터 변화가 나와요.");
}
for (const [key, label] of Object.entries(LABELS)) {
  const top3 = (today.charts[key] ?? []).slice(0, 3).map((id, i) => `${i + 1}. ${name(id)}`);
  lines.push("", `${label} TOP3`, ...top3);
  if (!yesterday) continue;
  const { fresh, risers } = movers(key);
  if (fresh.length) lines.push(`  새로 진입: ${fresh.slice(0, 5).map((f) => `${name(f.id)}(${f.rank}위)`).join(", ")}`);
  if (risers.length)
    lines.push(`  급상승: ${risers.slice(0, 5).map((r) => `${name(r.id)} ↑${r.gain}(${r.rank}위)`).join(", ")}`);
}

if (yesterday) {
  const genreRisers = Object.keys(today.charts)
    .filter((k) => k.startsWith("kr/free/"))
    .flatMap((k) => movers(k, 20, 10).risers.map((r) => ({ ...r, genre: k.split("/")[2] })))
    .sort((a, b) => b.gain - a.gain)
    .slice(0, 5);
  if (genreRisers.length)
    lines.push("", "🔥 장르별 급상승(국내 무료)", ...genreRisers.map((r) => `${r.genre}: ${name(r.id)} ↑${r.gain}(${r.rank}위)`));
  const surge = reviewSurge();
  if (surge.length) lines.push("", "💬 리뷰 급증", ...surge.map((s) => `${name(s.id)} +${s.added.toLocaleString("ko-KR")}`));
}

const tracked = Object.entries(today.searches ?? {}).map(([term, s]) => `${term}: ${s.hints.slice(1, 4).join(", ") || "-"}`);
if (tracked.length) lines.push("", "🔎 검색어 자동완성", ...tracked);

const text = lines.join("\n").slice(0, 4000);
if (DRY) {
  console.log(text);
} else {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 없음");
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`telegram: ${json.description}`);
  console.log("sent report", today.date);
}
