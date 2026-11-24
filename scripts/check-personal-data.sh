#!/usr/bin/env bash
# Commit check: this repo is public, so personal data must never be committed (AGENTS.md).
# Flags, in the files being committed:
#   - email addresses, except example.com / example.org / *.example and GitHub/Anthropic noreply
#   - US-style phone numbers
#   - files that look like inbox exports or real resumes
# False positive? Use an example.com address or an obviously fake number. Don't skip the hook.
set -euo pipefail

status=0
allowed_email='@(example\.(com|org|net)|[a-z0-9.-]+\.example|users\.noreply\.github\.com|anthropic\.com)$'

# Names that look like a real resume/CV or an inbox export, matched on the lowercased basename
# so `resume.pdf` at the root, `Paul_Resume.PDF` and `cv.docx` are all caught.
personal_name='(resume|cv|curriculum)[^/]*\.(pdf|docx?|odt|rtf|pages)$|\.(mbox|eml|pst|msg)$'

for f in "$@"; do
  [[ -f "$f" ]] || continue
  name=$(basename "$f" | tr '[:upper:]' '[:lower:]')
  if grep -qE "$personal_name" <<<"$name"; then
    echo "$f: looks like an inbox export or a real resume. Keep personal files in data/ (gitignored)."
    status=1; continue
  fi
  # Contents are only scanned in text files; binaries are judged by name above.
  grep -Iq . "$f" || continue
  # Emails: list every address, drop the allowed ones.
  while IFS= read -r hit; do
    [[ -z "$hit" ]] && continue
    if ! grep -qiE "$allowed_email" <<<"$hit"; then
      echo "$f: email address '$hit'. Use an example.com address instead."
      status=1
    fi
  done < <(grep -oiE '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}' "$f" | sort -u || true)
  # Phone numbers: (555) 123-4567, 555-123-4567, +1 555 123 4567. 555-01xx is the fictional range.
  if grep -nE '(\+1[ .-]?)?\(?[2-9][0-9]{2}\)?[ .-][0-9]{3}[ .-][0-9]{4}' "$f" | grep -vE '555[ .-]01[0-9]{2}' >/dev/null; then
    echo "$f: looks like a phone number. Use 555-01xx (reserved for fiction)."
    status=1
  fi
done

exit $status
