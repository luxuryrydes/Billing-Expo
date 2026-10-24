"""
Document worker as a web service (the `worker` service on Vercel).

POST /extract with the file bytes as the body and its name in the X-File-Name header;
returns the same JSON as `python extract.py <file>`. The service is internal: only the API
server reaches it, through the URL Vercel injects as WORKER_URL. Locally the API runs
extract.py directly and this file is not used.
"""
import os
import tempfile
from urllib.parse import unquote

from flask import Flask, jsonify, request

from extract import extract_file

ALLOWED = {".pdf", ".xlsx", ".xlsm", ".xls", ".docx", ".csv", ".png", ".jpg", ".jpeg", ".tif", ".tiff"}
MAX_BYTES = 30 * 1024 * 1024

app = Flask(__name__)


@app.post("/extract")
def extract():
    name = unquote(request.headers.get("X-File-Name", ""))
    ext = os.path.splitext(name)[1].lower()
    if ext not in ALLOWED:
        return jsonify({"error": f"Unsupported file type {ext or '(none)'}"}), 400
    body = request.get_data(cache=False)
    if not body:
        return jsonify({"error": "Empty file"}), 400
    if len(body) > MAX_BYTES:
        return jsonify({"error": "File too large"}), 413
    fd, path = tempfile.mkstemp(suffix=ext)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(body)
        out = extract_file(path)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass  # e.g. Windows while a reader still holds the file; the temp dir is cleared anyway
    return jsonify(out), (200 if "error" not in out else 422)


@app.get("/health")
def health():
    return jsonify({"ok": True})
