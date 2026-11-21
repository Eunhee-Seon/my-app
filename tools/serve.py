"""내 PC에서 화면과 api를 한 주소로 띄운다.

    python tools/serve.py          # http://localhost:8780
    python tools/serve.py 9000     # 다른 포트

- 프로젝트 폴더(my-app)를 정적 파일로 제공한다.
- .env 를 읽어 환경 변수로 넣는다(키 값은 화면에 찍지 않는다).
- POST /api/ask 는 Vercel 의 api/ask.py 와 같은 api/_llm.handle 로 처리한다.
"""

import json
import os
import sys
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PORT = 8780

sys.path.insert(0, str(ROOT / "api"))
from _llm import handle  # noqa: E402  (Vercel 의 api/ask.py 와 같은 로직)


def load_env(path: Path) -> None:
    if not path.exists():
        print("  .env 없음 — AI 호출은 동작하지 않습니다.")
        return
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if value and not os.environ.get(key):
            os.environ[key] = value
    has_key = bool(os.environ.get("GEMINI_API_KEY"))
    model = os.environ.get("GEMINI_MODEL") or "gemini-3.5-flash-lite"
    print(f"  .env 읽음 — GEMINI_API_KEY {'있음' if has_key else '비어 있음'}, 모델 {model}")


class Handler(SimpleHTTPRequestHandler):
    # Windows 레지스트리 설정과 상관없이 모듈 스크립트 · wasm 이 올바른 타입으로 나가게 고정
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".csv": "text/csv; charset=utf-8",
        ".md": "text/markdown; charset=utf-8",
        ".wasm": "application/wasm",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_head(self):
        # .env · 숨김 파일 · 서버 코드는 브라우저로 내보내지 않는다 (GET · HEAD 모두 여기를 지난다)
        path = urllib.parse.unquote(self.path.split("?", 1)[0].split("#", 1)[0])
        parts = [p for p in path.replace("\\", "/").split("/") if p]
        if any(p.startswith(".") for p in parts) or (parts and parts[0] in ("api", "tools")) \
                or "__pycache__" in parts:
            self.send_error(404)
            return None
        return super().send_head()

    def do_POST(self):
        if self.path.split("?", 1)[0] == "/api/ask":
            length = int(self.headers.get("Content-Length") or 0)
            status, body = handle(self.rfile.read(length))
            self._json(status, body)
            return
        self.send_error(404)

    def _json(self, status: int, body: dict) -> None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    load_env(ROOT / ".env")
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"  열기: http://localhost:{port}   (끄기: Ctrl+C)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  종료")


if __name__ == "__main__":
    main()
