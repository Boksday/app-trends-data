# app-trends-data

App Store 순위·앱 정보·검색어 자동완성을 매시간 모으는 저장소. 개인용 트렌드 앱(Boksday/byside의 apps/trends)이 이 데이터를 읽고, 매일 아침 8시(한국)에 텔레그램으로 요약을 보낸다.

- `scripts/collect.mjs`: 매시간 한국·미국·일본 무료·유료·매출 순위 100위, 한국·미국 장르별 무료 순위 50위, 앱 정보, `keywords.txt` 검색어의 자동완성과 검색 결과 순서를 받는다.
- `scripts/report.mjs`: 어제와 비교해 새로 진입·급상승·리뷰 급증을 텔레그램으로 보낸다(`--dry`는 출력만).
- `data/snapshots/YYYY-MM-DD.json`: 그날 마지막 수집. `data/apps.json`: 앱 정보. `data/index.json`: 날짜 목록.

데이터는 Apple이 공개한 순위 피드와 iTunes 검색 API에서 온다. 검색어 자동완성은 공개 문서가 없는 주소라 언제든 막힐 수 있다.
- `data/runs/YYYY-MM-DDTHH.json`: 매시간 순위·평가 수(급상승 계산용, 8일치만 남김). 스냅샷에는 구글 트렌드 한국 급상승 검색어(`trends`)도 들어간다.
- `big-publishers.txt`: 대기업 개발사 이름. 여기 있거나, 정부·공공기관이거나, 평가가 3만 개 넘는 앱은 `apps.json`에 `big: true`가 붙고 앱에서 기본으로 숨긴다.
- 인기 검색어(`popular`): 애플이 공개하지 않아서, 한국어 첫 글자 84개와 a~z를 넣은 자동완성(많이 찾는 순서)을 모아 점수를 매긴다. 3시간마다 갱신.
