// App Store 순위·앱 정보·검색어를 받아 data/에 쌓는다. GitHub Actions가 하루 4번 돌린다.
// 사용: node scripts/collect.mjs
//
// data/snapshots/YYYY-MM-DD.json  그날 마지막 수집(순위 앱 ID 목록, 리뷰 수, 검색어)
// data/apps.json                  순위에 든 적 있는 앱 정보(이름·개발사·장르·아이콘·평점)
// data/latest.json                가장 최근 수집(앱이 처음 읽는 파일)
// data/index.json                 쌓인 날짜 목록
import fs from "node:fs";

const ROOT = new URL("../", import.meta.url).pathname;
const DATA = `${ROOT}data`;
const COUNTRIES = ["kr", "us"];
const CHARTS = {
  free: "topfreeapplications",
  paid: "toppaidapplications",
  grossing: "topgrossingapplications",
};
/** 한국은 장르별 무료 순위도 50위까지 받는다. */
const KR_GENRES = {
  6014: "games",
  6015: "finance",
  6007: "productivity",
  6013: "health",
  6012: "lifestyle",
  6008: "photo",
  6005: "social",
  6024: "shopping",
  6017: "education",
  6016: "entertainment",
  6002: "utilities",
  6023: "food",
  6003: "travel",
  6011: "music",
};
const UA = "app-trends-data/1.0 (github.com/Boksday/app-trends-data)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error(`${res.status}`);
      return await res.json();
    } catch (error) {
      if (i >= tries) throw new Error(`${url}: ${error.message}`);
      await sleep(2000 * i);
    }
  }
}

/** 순위 피드에서 앱 ID 목록(1위부터) */
async function chart(country, feed, limit, genre) {
  const g = genre ? `/genre=${genre}` : "";
  const data = await getJson(`https://itunes.apple.com/${country}/rss/${feed}/limit=${limit}${g}/json`);
  return [].concat(data.feed?.entry ?? []).map((e) => e.id.attributes["im:id"]);
}

/** 앱 정보를 150개씩 묶어 조회한다(분당 약 20회 제한이라 사이를 띄운다). */
async function lookup(ids, country) {
  const out = {};
  for (let i = 0; i < ids.length; i += 150) {
    const batch = ids.slice(i, i + 150);
    const data = await getJson(`https://itunes.apple.com/lookup?id=${batch.join(",")}&country=${country}`);
    for (const a of data.results ?? []) {
      out[a.trackId] = {
        name: a.trackName,
        artist: a.artistName,
        genre: a.primaryGenreName,
        icon: a.artworkUrl100,
        url: a.trackViewUrl,
        price: a.price ?? 0,
        rating: a.averageUserRating ?? null,
        ratings: a.userRatingCount ?? 0,
        released: a.releaseDate,
        updated: a.currentVersionReleaseDate,
        country,
      };
    }
    await sleep(3500);
  }
  return out;
}

/** App Store 검색어 자동완성(비공식 주소). 많이 찾는 검색어가 위에 온다. */
async function hints(term) {
  const url = `https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/hints?clientApplication=Software&term=${encodeURIComponent(term)}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, "X-Apple-Store-Front": "143466-3,29" } });
  if (!res.ok) return [];
  const xml = await res.text();
  return [...xml.matchAll(/<key>term<\/key>\s*<string>([^<]+)<\/string>/g)].map((m) => m[1]);
}

/** 검색 결과 순서(앱 ID 25개) */
async function search(term) {
  const data = await getJson(
    `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&country=kr&entity=software&limit=25`,
  );
  return (data.results ?? []).map((a) => String(a.trackId));
}

const readJson = (path, fallback) => (fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : fallback);

async function main() {
  const now = new Date();
  // 한국 날짜 기준으로 하루를 나눈다.
  const date = new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
  const charts = {};
  for (const country of COUNTRIES) {
    for (const [name, feed] of Object.entries(CHARTS)) {
      charts[`${country}/${name}`] = await chart(country, feed, 100);
      await sleep(500);
    }
  }
  for (const [genre, name] of Object.entries(KR_GENRES)) {
    charts[`kr/free/${name}`] = await chart("kr", CHARTS.free, 50, genre);
    await sleep(500);
  }

  const keywords = fs
    .readFileSync(`${ROOT}keywords.txt`, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const searches = {};
  for (const term of keywords) {
    searches[term] = { hints: await hints(term).catch(() => []), results: await search(term) };
    await sleep(3500);
  }

  // 앱 정보: 나라마다 그 나라에 오른 앱만 조회한다.
  const apps = readJson(`${DATA}/apps.json`, {});
  const ratings = {};
  for (const country of COUNTRIES) {
    const ids = new Set();
    for (const [key, list] of Object.entries(charts)) if (key.startsWith(`${country}/`)) list.forEach((id) => ids.add(id));
    if (country === "kr") for (const s of Object.values(searches)) s.results.forEach((id) => ids.add(id));
    const info = await lookup([...ids], country);
    for (const [id, a] of Object.entries(info)) {
      apps[id] = { ...apps[id], ...a };
      ratings[id] = a.ratings;
    }
  }

  const snapshot = { date, at: now.toISOString(), charts, ratings, searches };
  fs.mkdirSync(`${DATA}/snapshots`, { recursive: true });
  fs.writeFileSync(`${DATA}/snapshots/${date}.json`, JSON.stringify(snapshot));
  fs.writeFileSync(`${DATA}/latest.json`, JSON.stringify(snapshot));
  fs.writeFileSync(`${DATA}/apps.json`, JSON.stringify(apps));
  const dates = fs
    .readdirSync(`${DATA}/snapshots`)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(".json", ""))
    .sort();
  fs.writeFileSync(`${DATA}/index.json`, JSON.stringify({ updated: now.toISOString(), dates }));
  console.log(`collected ${date}: ${Object.keys(charts).length} charts, ${Object.keys(apps).length} apps`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
