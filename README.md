# 인사 데이터 묻기

인사 시스템 추출 데이터(수업용 합성 데이터)를 브라우저 안의 DuckDB-WASM에 올려 두고, 한국어로 물으면 AI(Gemini)가 SQL을 써서 답하는 앱입니다. 탭은 준비된 질문 · 묻기 · 테이블 · 내 파일 네 개입니다.

## 쓰기 전에

1. 이 앱은 데이터를 브라우저 안에서 읽는다. 올린 파일은 서버에 저장되지 않는다
2. AI에는 질문 · 테이블 설명 · 집계 결과(최대 50행)만 간다. 원본 행은 가지 않는다
3. AI가 쓴 SQL은 실행 전에 읽어 보고, 결과 숫자 하나는 직접 검산한다
4. 올린 파일의 «읽은 행 수»와 «올라간 행 수»가 다르면(✕) 그 결과를 믿지 않는다
5. 파일 이름이 같으면 나중에 올린 파일이 앞의 것을 대신한다

## 내 PC에서 실행

1. `.env.example`을 `.env`로 복사하고 `GEMINI_API_KEY=` 뒤에 키를 넣습니다. `.env`는 git과 배포에서 빠집니다.
2. `python tools/serve.py` → http://localhost:8780

## Vercel 배포

- 저장소를 Vercel에 연결하면 정적 파일(`index.html` · `js/` · `css/` · `data/` · `schema.json` · `questions/`)과 Python 함수(`api/ask.py`)가 그대로 배포됩니다.
- Vercel 프로젝트 설정 → Environment Variables에 `GEMINI_API_KEY`(필수)와 `GEMINI_MODEL`(선택, 기본 `gemini-3.5-flash-lite`)을 넣습니다.
- `tools/` · `.env` · `다음달/`은 `.vercelignore`로 배포에서 뺍니다.

## 파일

| 경로 | 하는 일 |
|---|---|
| `schema.json` | AI에 보내는 테이블 설명(그레인 · 행 수 · 컬럼 · 지표 정의 · 회사 규칙). `docs/데이터_사전.md` 기준 |
| `questions/prepared.json` | 검증한 준비된 질문과 SQL |
| `js/guard.js` · `api/_sqlguard.py` | 읽기 전용 SQL 검사(같은 규칙) |
| `js/db.js` | DuckDB-WASM 적재 · 실행 |
| `api/ask.py` · `api/_llm.py` | Gemini 호출(Vercel 함수) |
| `tools/serve.py` | 내 PC용 서버(화면 + api) |
