# -*- coding: utf-8 -*-
"""
Lokalny OCR server pre citacku osvedceni o evidencii vozidla (OSV).

Bezi na vasom pocitaci, nic sa nikam neodosiela. Web aplikacia mu.posle
obrazok a server vrati precitane polia ( oficiálne kody pozicii OSV).

Inštalácia:
  1) Nainstalujte Tesseract OCR:
     - Windows: installer z https://github.com/UB-Mannheim/tesseract/wiki
       (pri instalacii zaskrtnite jazyk "Slovak")
     - Linux:   sudo apt install tesseract-ocr tesseract-ocr-slv
     - macOS:   brew install tesseract tesseract-lang
  2) pip install flask flask-cors
  3) Spustenie:  python server.py   (pocuva na http://localhost:8000)

Volanie: POST http://localhost:8000/ocr  (multipart pole "image")
"""
import re
import shutil
import subprocess
import unicodedata

from flask import Flask, request, jsonify
from flask_cors import CORS

try:
    from flask_cors import cross_origin
except ImportError:  # pragma: no cover
    cross_origin = None

app = Flask(__name__)
CORS(app, supports_credentials=False)

TESSERACT = shutil.which("tesseract")
if TESSERACT is None:
    raise SystemExit(
        "Tesseract OCR nie je nainstalovany. Nainstalujte ho (pozri komentar v hlavicke) a potom spustite server znova."
    )

# Oficialne kody pozicii OSV -> cast dokladu
CODES = [
    "C.1.1", "C.1.3", "C.2.1", "C.2.3",
    "D.1", "D.2", "D.3",
    "F.1", "F.2", "F.3",
    "O.1", "O.2",
    "P.1", "P.2", "P.3", "P.4", "P.5",
    "S.1", "S.2",
    "V.1", "V.2", "V.3", "V.4", "V.5", "V.6", "V.7", "V.8", "V.9",
    "A", "B", "E", "H", "I",
    "J", "K", "L", "M", "N", "Q", "R", "T", "W", "G",
]

CODE_PARTS = {
    "A": "casť I", "B": "casť I", "E": "casť I", "H": "casť I", "I": "casť I",
    "C.1.1": "casť I", "C.1.3": "casť I", "C.2.1": "casť I", "C.2.3": "casť I",
}

NAME_MATCHERS = [
    (r"evidencne cislo|evidencne", "casť I"),
    (r"vin", "casť I"),
    (r"znacka", "casť II"),
    (r"kateg", "casť II"),
    (r"palivo|zdroj energie", "casť II"),
    (r"objem|zdvihov", "casť II"),
    (r"vykon", "casť II"),
    (r"farba", "casť II"),
    (r"miest|lozok", "casť II"),
    (r"nadrz", "casť II"),
    (r"razvor", "casť II"),
    (r"hmotnos", "casť II"),
    (r"rychlos", "casť II"),
    (r"pneumat|rafik|naprav", "casť II"),
    (r"spotreba|emisie|dymivos|co2|nox", "casť II"),
    (r"meno|priezvisko|vlastnik|drzite", "casť I"),
    (r"pobyt|bydlis|adres", "casť I"),
    (r"datum (prvej )?registr|prvej evidenc|rok vyroby", "casť I"),
    (r"platnos", "casť I"),
    (r"peciatka|podpis", "casť I"),
    (r"technickeho osved|cislo technick", "casť I"),
]


def strip_diacritics(text: str) -> str:
    decomposed = unicodedata.normalize("NFD", text.lower())
    return re.sub(r"[\u0300-\u036f]", "", decomposed)


def normalize(text: str) -> str:
    cleaned = re.sub(r"[^a-z0-9. ]", " ", strip_diacritics(text))
    return re.sub(r"\s+", " ", cleaned).strip()


def resolve_part(label: str) -> str | None:
    normalized = normalize(label)
    if not normalized:
        return None
    for code in CODES:
        pattern = r"(^| )" + re.escape(code.lower()).replace(r"\.", r"\.?") + r"( |$)"
        if re.search(pattern, normalized):
            return CODE_PARTS.get(code, "casť II")
    for pattern, part in NAME_MATCHERS:
        if re.search(pattern, normalized):
            return part
    return None


def read_tsv(image_path: str) -> list[dict]:
    result = subprocess.run(
        [TESSERACT, image_path, "stdout", "-l", "slv+eng", "tsv"],
        capture_output=True,
        text=True,
        check=True,
    )
    lines: list[dict] = []
    rows = [row.split("\t") for row in result.stdout.splitlines() if row.count("\t") >= 11]
    grouped: dict[int, list] = {}
    for row in rows:
        level, _page, block, par, line_num, _word, left, top, width, height, conf, text = row[:12]
        if level != "5" or not text.strip():
            continue
        line = grouped.setdefault((int(block), int(par), int(line_num)), {"words": [], "conf": []})
        line["words"].append(
            {"text": text, "x0": int(left), "y0": int(top), "x1": int(left) + int(width), "y1": int(top) + int(height)}
        )
        if float(conf) >= 0:
            line["conf"].append(float(conf))
    for line in sorted(grouped.values(), key=lambda l: l["words"][0]["y0"]):
        line["text"] = " ".join(w["text"] for w in line["words"])
        line["bbox"] = {
            "x0": min(w["x0"] for w in line["words"]),
            "y0": min(w["y0"] for w in line["words"]),
            "x1": max(w["x1"] for w in line["words"]),
            "y1": max(w["y1"] for w in line["words"]),
        }
        lines.append(line)
    return lines


def split_label_value(line: dict) -> tuple[str, str] | None:
    words = line["words"]
    if len(words) < 2:
        return None
    height = max(1, line["bbox"]["y1"] - line["bbox"]["y0"])
    threshold = max(22, height * 1.2)
    split_index = -1
    for i in range(1, len(words)):
        gap = words[i]["x0"] - words[i - 1]["x1"]
        if gap >= threshold:
            split_index = i
            break
    if split_index == -1:
        return None
    label = " ".join(w["text"] for w in words[:split_index]).strip()
    value = " ".join(w["text"] for w in words[split_index:]).strip()
    if not label or not value:
        return None
    return label, value


def certainty_of(confidences: list[float]) -> str:
    if not confidences:
        return "dobrá"
    avg = sum(confidences) / len(confidences)
    if avg >= 85:
        return "výborná"
    if avg >= 65:
        return "dobrá"
    return "nízka"


@app.post("/ocr")
def ocr():
    if "image" not in request.files:
        return jsonify({"error": "Chýba pole 'image' (multipart/form-data)."}), 400
    upload = request.files["image"]
    extension = ".png" if upload.filename.lower().endswith(".png") else ".jpg"
    image_path = f"/tmp/ocr_server_input{extension}"
    upload.save(image_path)
    try:
        fields = []
        seen = set()
        for line in read_tsv(image_path):
            split = split_label_value(line)
            if not split:
                continue
            label, value = split
            part = resolve_part(label)
            if not part:
                continue
            key = normalize(label)
            if key in seen:
                continue
            seen.add(key)
            fields.append(
                {"label": label, "value": value, "part": part, "certainty": certainty_of(line["conf"])}
            )
        return jsonify(
            {
                "documentType": "Osvedčenie o evidencii vozidla (lokálny server OCR)",
                "fields": fields,
                "notes": "",
                "rawText": "",
            }
        )
    except subprocess.CalledProcessError as error:
        return jsonify({"error": f"Tesseract zlyhal: {error.stderr}"}), 500


@app.get("/health")
def health():
    return jsonify({"ok": True, "tesseract": TESSERACT})


if __name__ == "__main__":
    print("OCR server bezi na http://localhost:8000 (POST /ocr)")
    app.run(host="127.0.0.1", port=8000)
