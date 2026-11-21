// A faster drop-in for csv-reader 1.0.0 (make.fun's own reference program).
// run(input) returns exactly what csv-reader 1.0.0 returns for {text, header}:
// {columns, rows, errors} with csv-reader's broken-CSV semantics:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled,
//     "" inside it one quote, each CRLF or lone CR inside it read as LF; what
//     follows its closing quote, up to the next comma or line break, is appended
//     as it stands (quote_junk, when the field ends); a quote that never closes
//     is a literal character, and the text after it is read again as unquoted
//     (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the
//     records after it (every record when header is false), each padded with ""
//     (short_row, with fields: its field count) or cut (long_row, with extra:
//     the cut fields) to the first record's width;
//   - each error is {code, line, row}, in the order met, a field's quote_junk
//     when the field ends and a record's short_row or long_row when the record
//     ends; line is the 1-based line its record starts on.
//
// Speed: the reference reads one character at a time and builds every field by
// per-character concatenation. This parser instead slices whole fields at once:
// for an unquoted field it finds the next comma and the next line break with
// indexOf (both native, bounded by the record), slices the field in one go, and
// only falls back to a character loop when the slice holds a stray CR (rare).
// Quoted fields are found with indexOf on the closing quote, sliced in one go,
// with doubled quotes collapsed by joining at most a few segments. Line breaks
// inside quotes are counted with indexOf, not a character loop. The slow
// character paths exist only for broken rows, so the common case never pays
// for them. Pure: no clock, no randomness, no locale, nothing kept between calls.

/** How a field ended: 0 at a comma, 1 at a line break, 2 at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // Index of the next LF at or after pos, -1 when there is none; recomputed
  // lazily whenever pos moves past it (a quoted field may span lines).
  let lineEnd = -1;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // The field just read: its value, how it ended, and how many characters
  // were kept after the initial value (for quote_junk). Shared out-variables
  // instead of a fresh object per field, to keep 1M+ fields cheap.
  let fv = '';
  let fe = 0;
  let fa = 0;

  // Reads an unquoted field from pos, starting from `init` ('' normally, the
  // quoted content for quote junk, '"' for an unterminated quote), into
  // fv/fe/fa; `added` counts the characters kept after `init`.
  function readUnquoted(init) {
    if (lineEnd < pos) lineEnd = text.indexOf('\n', pos);
    const comma = text.indexOf(',', pos);
    let end;
    let ended;
    if (comma !== -1 && (lineEnd === -1 || comma < lineEnd)) {
      end = comma;
      ended = COMMA;
    } else if (lineEnd !== -1) {
      end = lineEnd;
      ended = LINE_BREAK;
    } else {
      end = len;
      ended = END;
    }
    // A CR just before the line break is the CRLF's CR, not part of the field.
    let contentEnd = end;
    if (ended === LINE_BREAK && end > pos && text.charCodeAt(end - 1) === 13) contentEnd = end - 1;
    const piece = text.slice(pos, contentEnd);
    if (piece.indexOf('\r') === -1) {
      pos = ended === END ? len : end + 1;
      if (ended === LINE_BREAK) line += 1;
      fv = init === '' ? piece : init + piece;
      fe = ended;
      fa = piece.length;
      return;
    }
    // Slow path: a stray CR sits inside this field. Read it character by
    // character, exactly as the reference does: a CR not followed by LF is
    // dropped (stray_cr); a CR followed by LF, a comma or an LF ends the field.
    let value = init;
    let added = 0;
    let p = pos;
    for (;;) {
      if (p >= len) {
        pos = len;
        fv = value;
        fe = END;
        fa = added;
        return;
      }
      const c = text.charCodeAt(p);
      if (c === 44) {
        pos = p + 1;
        fv = value;
        fe = COMMA;
        fa = added;
        return;
      }
      if (c === 10) {
        pos = p + 1;
        line += 1;
        fv = value;
        fe = LINE_BREAK;
        fa = added;
        return;
      }
      if (c === 13) {
        if (text.charCodeAt(p + 1) === 10) {
          pos = p + 2;
          line += 1;
          fv = value;
          fe = LINE_BREAK;
          fa = added;
          return;
        }
        error('stray_cr');
        p += 1;
        continue;
      }
      value += text[p];
      added += 1;
      p += 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let segStart = pos + 1;
    let parts = null; // segments before each doubled quote, joined at the end
    let q = text.indexOf('"', segStart);
    while (q !== -1 && text.charCodeAt(q + 1) === 34) {
      if (parts === null) parts = [];
      parts.push(text.slice(segStart, q));
      parts.push('"');
      segStart = q + 2;
      q = text.indexOf('"', segStart);
    }
    if (q === -1) {
      // The quote never closes: it is a literal character, and the text after
      // it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      error('unterminated_quote');
      readUnquoted('"');
      return;
    }
    // The closing quote is at q; the content is [open + 1, q) with "" as one ".
    let value;
    if (parts === null) value = text.slice(segStart, q);
    else {
      parts.push(text.slice(segStart, q));
      value = parts.join('');
    }
    // Line breaks inside the quotes: every LF, and every CR (a CRLF counts
    // once), each read as LF in the value.
    if (value.indexOf('\r') === -1) {
      let n = value.indexOf('\n');
      while (n !== -1) {
        line += 1;
        n = value.indexOf('\n', n + 1);
      }
    } else {
      let v = '';
      let s = 0;
      for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        if (c === 13) {
          v += value.slice(s, i);
          v += '\n';
          line += 1;
          if (value.charCodeAt(i + 1) === 10) i += 1;
          s = i + 1;
        } else if (c === 10) {
          line += 1;
        }
      }
      v += value.slice(s);
      value = v;
    }
    pos = q + 1;
    if (pos >= len) {
      fv = value;
      fe = END;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fv = value;
      fe = COMMA;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fv = value;
      fe = LINE_BREAK;
      return;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fv = value;
      fe = LINE_BREAK;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break.
    readUnquoted(value);
    if (fa > 0) error('quote_junk');
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) readQuoted();
      else readUnquoted('');
      fields.push(fv);
    } while (fe === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
