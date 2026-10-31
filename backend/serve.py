"""Start the PDF Analyzer server.  See README.md for flags."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"


def main() -> None:
    p = argparse.ArgumentParser(description="Local PDF Q&A server (UI + API).")
    p.add_argument("--host", default="127.0.0.1", help="interface to bind (default: 127.0.0.1, local only)")
    p.add_argument("--port", type=int, default=8000, help="port to listen on (default: 8000)")
    p.add_argument("--data-dir", default=os.environ.get("PDF_ANALYZER_DATA", ROOT / "data"),
                   help="where PDFs and comments are stored (default: ./data)")
    p.add_argument("--workers", type=int, default=3,
                   help="max PDFs Claude answers concurrently (default: 3)")
    p.add_argument("--model", default=None,
                   help="Claude model alias or id, e.g. opus, sonnet (default: Claude Code's default)")
    p.add_argument("--build", action="store_true",
                   help="rebuild the frontend before starting (done automatically if never built)")
    p.add_argument("--reload", action="store_true", help="auto-restart the backend on code changes (development)")
    args = p.parse_args()

    os.environ["PDF_ANALYZER_DATA"] = str(Path(args.data_dir).resolve())
    os.environ["PDF_ANALYZER_WORKERS"] = str(args.workers)
    if args.model:
        os.environ["PDF_ANALYZER_MODEL"] = args.model

    if args.build or not (FRONTEND / "dist" / "index.html").exists():
        if not (FRONTEND / "node_modules").exists():
            subprocess.run(["npm", "install"], cwd=FRONTEND, check=True)
        subprocess.run(["npm", "run", "build"], cwd=FRONTEND, check=True)

    import uvicorn

    sys.path.insert(0, str(Path(__file__).parent))
    print(f"PDF Analyzer: http://{args.host}:{args.port}  (data: {os.environ['PDF_ANALYZER_DATA']})")
    if args.reload:
        uvicorn.run("app:app", host=args.host, port=args.port, reload=True,
                    app_dir=str(Path(__file__).parent), log_level="info", timeout_graceful_shutdown=1)
        return

    class Server(uvicorn.Server):
        # Browser tabs hold SSE connections open forever; on Ctrl+C end them right away
        # instead of "Waiting for connections to close".
        def handle_exit(self, sig, frame):
            app_module = sys.modules.get("app")
            if app_module:
                app_module.bus.close_all()
            super().handle_exit(sig, frame)

    config = uvicorn.Config("app:app", host=args.host, port=args.port, log_level="info",
                            timeout_graceful_shutdown=1)
    Server(config).run()


if __name__ == "__main__":
    main()
