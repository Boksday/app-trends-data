// App Store 순위·앱 정보·검색어를 받아 data/에 쌓는다. GitHub Actions가 하루 4번 돌린다.
// 사용: node scripts/collect.mjs
//
// data/snapshots/YYYY-MM-DD.json  그날 마지막 수집(순위 앱 ID 목록, 리뷰 수, 검색어)
// data/apps.json                  순위에 든 적 있는 앱 정보(이름·개발사·장르·아이콘·평점)
// data/latest.json                가장 최근 수집(앱이 처음 읽는 파일)
// data/index.json                 쌓인 날짜와 시간별 기록 목록
// data/runs/YYYY-MM-DDTHH.json    매시간 수집(순위·평가 수만). 급상승 계산용이라 8일치만 남긴다.
import fs from "node:fs";

const ROOT = new URL("../", import.meta.url).pathname;
const DATA = `${ROOT}data`;
// 해외(미국·일본)에서 먼저 뜬 앱이 한국에서 뒤늦게 뜨는 경우가 많아, 해외도 장르별로 모은다.
const COUNTRIES = ["kr", "us", "jp"];
/** 장르별 무료 50위를 모으는 나라 */
const GENRE_COUNTRIES = ["kr", "us"];
const CHARTS = {
  free: "topfreeapplications",
  paid: "toppaidapplications",
  grossing: "topgrossingapplications",
};
/** 장르별 무료 순위 50위 */
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

/** 구글 트렌드 한국 급상승 검색어(공식 RSS) */
async function googleTrends() {
  const res = await fetch("https://trends.google.com/trending/rss?geo=KR", { headers: { "User-Agent": UA } });
  if (!res.ok) return [];
  const xml = await res.text();
  return [...xml.matchAll(/<item>\s*<title>([^<]+)<\/title>[\s\S]*?<ht:approx_traffic>([^<]*)<\/ht:approx_traffic>/g)].map((m) => ({
    term: m[1],
    traffic: m[2],
  }));
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

/**
 * 사람들이 실제로 많이 찾는 검색어. 애플은 인기 검색어를 공개하지 않아서, 한국어 첫 글자 84개와 영어 a~z를
 * 넣어 나오는 자동완성(많이 찾는 순서)을 모은다. 위에 나올수록 점수가 높다(1위 10점 … 10위 1점).
 */
const VOWELS = [0, 4, 8, 13, 20, 1]; // ㅏ ㅓ ㅗ ㅜ ㅣ ㅐ (유니코드 중성 순번)
const INITIAL_INDEX = [0, 2, 3, 5, 6, 7, 9, 11, 12, 14, 15, 16, 17, 18];
function popularSeeds() {
  const syllables = INITIAL_INDEX.flatMap((c) => VOWELS.map((v) => String.fromCharCode(0xac00 + (c * 21 + v) * 28)));
  return [...syllables, ..."abcdefghijklmnopqrstuvwxyz"];
}
async function popularTerms() {
  const score = new Map();
  for (const seed of popularSeeds()) {
    const list = await hints(seed).catch(() => []);
    list.slice(0, 10).forEach((term, i) => {
      if (term.length < 2) return;
      score.set(term, (score.get(term) ?? 0) + (10 - i));
    });
    await sleep(800);
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 400)
    .map(([term, points]) => ({ term, points }));
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
  for (const country of GENRE_COUNTRIES) {
    for (const [genre, name] of Object.entries(KR_GENRES)) {
      charts[`${country}/free/${name}`] = await chart(country, CHARTS.free, 50, genre);
      await sleep(500);
    }
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

  const trends = await googleTrends().catch(() => []);
  // 인기 검색어는 요청이 많아 3시간마다(한국 0·3·6…시) 모은다. 그 사이에는 오늘 스냅샷에 있던 것을 그대로 둔다.
  const kstHour = new Date(now.getTime() + 9 * 3600_000).getUTCHours();
  const previous = readJson(`${DATA}/snapshots/${date}.json`, null);
  const popular =
    kstHour % 3 === 0 || !previous?.popular || process.env.FORCE_POPULAR
      ? await popularTerms()
      : previous.popular;
  // 대기업 표시: big-publishers.txt의 이름이 개발사에 들어 있으면 big. 앱에서 기본으로 숨긴다.
  const bigNames = fs
    .readFileSync(`${ROOT}big-publishers.txt`, "utf8")
    .split("\n")
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l && !l.startsWith("#"));
  // 정부·공공기관과, 평가가 3만 개 넘게 쌓여 이미 자리 잡은 앱도 1인 개발에 참고가 안 되니 같이 뺀다.
  const PUBLIC = /(ministry|department of|government|정부|[가-힣]+(부|청|처|공단|공사|진흥원|정보원)$|^국민|^한국[가-힣]*(공사|공단|원)$)/i;
  for (const a of Object.values(apps)) {
    const artist = (a.artist ?? "").toLowerCase();
    a.big = bigNames.some((n) => artist.includes(n)) || PUBLIC.test(a.artist ?? "") || (a.ratings ?? 0) >= 30_000;
  }

  const snapshot = { date, at: now.toISOString(), charts, ratings, searches, trends, popular };
  fs.mkdirSync(`${DATA}/snapshots`, { recursive: true });
  fs.writeFileSync(`${DATA}/snapshots/${date}.json`, JSON.stringify(snapshot));
  fs.writeFileSync(`${DATA}/latest.json`, JSON.stringify(snapshot));
  fs.writeFileSync(`${DATA}/apps.json`, JSON.stringify(apps));
  // 시간별 기록(순위·평가 수만)과 8일 넘은 기록 지우기
  const hour = new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 13);
  fs.mkdirSync(`${DATA}/runs`, { recursive: true });
  fs.writeFileSync(`${DATA}/runs/${hour}.json`, JSON.stringify({ at: now.toISOString(), charts, ratings }));
  const keepFrom = new Date(now.getTime() + 9 * 3600_000 - 8 * 86_400_000).toISOString().slice(0, 13);
  const runs = fs
    .readdirSync(`${DATA}/runs`)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(".json", ""))
    .sort()
    .filter((r) => {
      if (r >= keepFrom) return true;
      fs.unlinkSync(`${DATA}/runs/${r}.json`);
      return false;
    });
  const dates = fs
    .readdirSync(`${DATA}/snapshots`)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(".json", ""))
    .sort();
  fs.writeFileSync(`${DATA}/index.json`, JSON.stringify({ updated: now.toISOString(), dates, runs }));
  console.log(`collected ${date}: ${Object.keys(charts).length} charts, ${Object.keys(apps).length} apps`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
