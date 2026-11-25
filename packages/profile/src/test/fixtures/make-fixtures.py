"""Regenerates the synthetic resume fixtures (sample.docx, sample.pdf) for packages/profile tests.

Run from this folder: python3 make-fixtures.py
Synthetic content only (invented person and employer): the repo is public.
"""

import zipfile

LINES = [
    "Alex Example",
    "Senior Software Engineer, Example Payments",
    "Made payment retries idempotent in Go and Postgres.",
]

# A minimal DOCX: three parts are enough for Word and mammoth.
CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""
RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""
PARAGRAPHS = "".join(f"<w:p><w:r><w:t>{line}</w:t></w:r></w:p>" for line in LINES)
DOCUMENT = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{PARAGRAPHS}</w:body></w:document>"""

with zipfile.ZipFile("sample.docx", "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", CONTENT_TYPES)
    z.writestr("_rels/.rels", RELS)
    z.writestr("word/document.xml", DOCUMENT)

# A minimal one-page PDF with the same lines, built with correct xref offsets.
text_ops = "BT /F1 12 Tf 72 720 Td 16 TL " + " ".join(f"({line}) Tj T*" for line in LINES) + " ET"
objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
    "/Resources << /Font << /F1 5 0 R >> >> >>",
    f"<< /Length {len(text_ops)} >>\nstream\n{text_ops}\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
]
out = b"%PDF-1.4\n"
offsets = []
for i, body in enumerate(objects, start=1):
    offsets.append(len(out))
    out += f"{i} 0 obj\n{body}\nendobj\n".encode()
xref = len(out)
out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
out += "".join(f"{o:010d} 00000 n \n" for o in offsets).encode()
out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
with open("sample.pdf", "wb") as f:
    f.write(out)
