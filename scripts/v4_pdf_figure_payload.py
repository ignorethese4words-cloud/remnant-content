#!/usr/bin/env python3
"""Prepare one licensed, exact-site USGS PDF figure for the V4 media ingest API.

The input request must already contain independently verified identity, rights,
a zero-based PDF page, and normalized crop coordinates. Extraction itself does
not establish those facts or approve the image.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.parse
import urllib.request

MAX_PDF = 80 * 1024 * 1024
MAX_IMAGE = 4 * 1024 * 1024
PDF_HOST = "pubs.usgs.gov"


def validate_url(url):
    if not isinstance(url, str):
        raise ValueError("sourcePdfUri must be an HTTPS USGS PDF URL")
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname != PDF_HOST or parsed.username or parsed.password:
        raise ValueError("PDF download restricted to https://pubs.usgs.gov")
    if not parsed.path.lower().endswith(".pdf"):
        raise ValueError("PDF source must be a .pdf file")
    return url


class NoUnsafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        validate_url(newurl)
        return super().redirect_request(request, fp, code, msg, headers, newurl)


def download_pdf(url):
    request = urllib.request.Request(validate_url(url), headers={"User-Agent": "Remnant-V4-Media/1.1 (archive extraction)"})
    opener = urllib.request.build_opener(NoUnsafeRedirect)
    with opener.open(request, timeout=50) as response:
        length = int(response.headers.get("Content-Length", "0"))
        if length > MAX_PDF:
            raise ValueError("PDF exceeds 80MB processing limit")
        chunks, count = [], 0
        while True:
            chunk = response.read(65536)
            if not chunk:
                break
            count += len(chunk)
            if count > MAX_PDF:
                raise ValueError("PDF exceeds 80MB processing limit")
            chunks.append(chunk)
    data = b"".join(chunks)
    if not data.startswith(b"%PDF-"):
        raise ValueError("source is not a PDF")
    return data


def make_payload(record, pdf_bytes):
    import pymupdf

    page_index = record.get("pdfPageIndex")
    if type(page_index) is not int or page_index < 0:
        raise ValueError("pdfPageIndex must be a zero-based integer")
    crop = record.get("pdfCropBox")
    if not isinstance(crop, list) or len(crop) != 4:
        raise ValueError("pdfCropBox must be [left, top, right, bottom], normalized 0..1")
    if any(type(x) not in (int, float) or not (0 <= x <= 1) for x in crop):
        raise ValueError("all crop coordinates must be numbers in 0..1")
    l, t, r, b = crop
    if r - l < .08 or b - t < .08:
        raise ValueError("crop is too small to be an inspectable figure")

    mime = record.get("pdfOutputMime", "image/png")
    if mime not in ("image/png", "image/jpeg"):
        raise ValueError("pdfOutputMime must be image/png or image/jpeg")
    with pymupdf.open(stream=pdf_bytes, filetype="pdf") as doc:
        if page_index >= len(doc):
            raise ValueError(f"page index {page_index} exceeds PDF length {len(doc)}")
        page = doc[page_index]
        rect = page.rect
        clip = pymupdf.Rect(
            rect.x0 + rect.width * l, rect.y0 + rect.height * t,
            rect.x0 + rect.width * r, rect.y0 + rect.height * b
        )
        img = None
        for dpi in (210, 180, 150, 120):
            pix = page.get_pixmap(dpi=dpi, clip=clip, alpha=False, colorspace=pymupdf.csRGB)
            if pix.width < 300 or pix.height < 220:
                raise ValueError("figure extraction too small for app use")
            img = pix.tobytes("png" if mime == "image/png" else "jpeg", jpg_quality=88)
            if len(img) <= MAX_IMAGE:
                break
        if not img or len(img) > MAX_IMAGE:
            raise ValueError("figure exceeds 4MB even after resizing")

    payload = dict(record)
    payload["expectedMime"] = mime
    payload["preparedImageBase64"] = base64.b64encode(img).decode("ascii")
    payload["sourceNote"] = (
        str(record.get("sourceNote", "")).strip()
        + f" | Figure cropped from original PDF page index {page_index} "
        + f"(printed page independently verified); normalized crop {crop}; "
        + "rasterized for Remnant media storage."
    )
    payload.pop("sourceUri", None)
    return payload, img


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: v4_pdf_figure_payload.py REQUEST_JSON OUTPUT_JSON")
    source, target = Path(sys.argv[1]), Path(sys.argv[2])
    original = json.loads(source.read_text())
    if original.get("status") != "READY":
        raise ValueError("only READY requests may be processed")
    validate_url(original.get("sourcePdfUri"))
    pdf = download_pdf(original["sourcePdfUri"])
    payload, image = make_payload(original, pdf)
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as out:
        json.dump(payload, out, separators=(",", ":"))
    print(f"Prepared PDF figure: pageIndex={payload['pdfPageIndex']}, imageBytes={len(image)}, "
          f"SHA256={hashlib.sha256(image).hexdigest()}, awaiting authenticated storage/approval.")


if __name__ == "__main__":
    main()
