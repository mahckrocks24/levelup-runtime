'use strict';

/**
 * attachment-interpreter.js — v2.30.0 (v1.4.4)
 *
 * Turns a user-uploaded attachment into agent-readable context.
 *
 *   Image     → GPT-4o vision describe (uses existing /internal/vision/analyze)
 *   PDF       → pdf-parse → first N chars of extracted text
 *   DOCX      → mammoth   → first N chars of extracted text
 *   XLS/XLSX  → xlsx      → sheet names + first 50 rows per sheet (markdown table)
 *   CSV/TXT   → raw text  → first N chars
 *   Other     → name + mime + size only (the agent can acknowledge it exists,
 *               but cannot read inside)
 *
 * Why this lives in the runtime (not Laravel):
 *   Per the hands-vs-brain rule + the intelligence-belongs-in-runtime memory,
 *   anything that "interprets" content goes in the runtime. Laravel stays the
 *   brain for state + governance; the runtime is the only place that touches
 *   DeepSeek/OpenAI and downloads files for analysis.
 *
 * Hard limits:
 *   - Max remote file size: 30 MB (bigger files get a truncated read).
 *   - Max extracted-text length: 6 000 chars per attachment (~1500 tokens).
 *   - Request timeout: 60s.
 *
 * Public API:
 *   interpretOne({ url, mime, kind, name })  → { ok, kind, summary, extracted_text?, vision_describe?, error? }
 *   interpretMany([attachments])             → array of the above
 *   formatForPrompt(interpreted[])           → ready-to-append USER_ATTACHMENTS block
 *
 * Called by /internal/interpret-attachment (HTTP) AND by index.js's
 * chat / agent-reply paths before they assemble the final LLM prompt.
 */

const axios = require('axios');

const MAX_REMOTE_BYTES        = 30 * 1024 * 1024;
const MAX_EXTRACTED_CHARS     = 6000;
const DOWNLOAD_TIMEOUT_MS     = 30000;
const VISION_PROMPT_DEFAULT   = 'Describe this image factually for a marketing agent: what it shows, what text is visible, any logos or brand colours, mood and style. 80-150 words.';

async function interpretOne(att) {
    const { url, mime, kind, name } = att || {};
    if (!url) return { ok: false, kind: kind || 'unknown', name, error: 'url required' };

    const lowerMime = String(mime || '').toLowerCase();
    const effectiveKind = kind || _kindFromMime(lowerMime, name || '');

    try {
        if (effectiveKind === 'image') {
            return await _interpretImage(url, name);
        }
        if (effectiveKind === 'document' || effectiveKind === 'pdf' || lowerMime.includes('pdf')) {
            if (lowerMime.includes('pdf') || _ext(name) === 'pdf')   return await _interpretPdf(url, name);
            if (lowerMime.includes('word') || _ext(name).match(/docx?/)) return await _interpretDocx(url, name);
            if (lowerMime.includes('excel') || lowerMime.includes('spreadsheet') || _ext(name).match(/xlsx?/)) return await _interpretXlsx(url, name);
            if (lowerMime.startsWith('text/') || _ext(name).match(/csv|txt/))  return await _interpretText(url, name);
            return { ok: true, kind: 'document', name, summary: `${name || 'a document'} (${mime || 'unknown'}, content not extracted yet)` };
        }
        if (effectiveKind === 'video') {
            return { ok: true, kind: 'video', name, summary: `${name || 'a video'} attached (${mime || 'video'}). The agent can acknowledge the video but cannot watch it directly yet.` };
        }
        return { ok: true, kind: effectiveKind, name, summary: `${name || 'a file'} attached (${mime || 'unknown'}). The agent can reference it but cannot read its contents.` };
    } catch (err) {
        return {
            ok: false,
            kind: effectiveKind,
            name,
            error: (err && err.message) || String(err),
        };
    }
}

async function interpretMany(attachments) {
    const list = Array.isArray(attachments) ? attachments : [];
    const results = [];
    for (const a of list) {
        results.push(await interpretOne(a));
    }
    return results;
}

/**
 * Build a `USER_ATTACHMENTS:` block that can be appended verbatim to a
 * system or user prompt. Returns an empty string if there are none.
 */
function formatForPrompt(interpreted) {
    if (!Array.isArray(interpreted) || interpreted.length === 0) return '';
    const lines = ['USER_ATTACHMENTS — the user shared these files with this message:'];
    interpreted.forEach((it, i) => {
        const idx = i + 1;
        const head = `${idx}. ${it.name || '(unnamed)'} — ${it.kind || 'unknown'}`;
        lines.push(head);
        if (it.summary)         lines.push('   Summary: ' + _oneLine(it.summary));
        if (it.vision_describe) lines.push('   What it shows: ' + _oneLine(it.vision_describe));
        if (it.extracted_text)  lines.push('   Extracted content:\n' + _indent(it.extracted_text, '   '));
        if (it.error)           lines.push('   (Could not read this file: ' + it.error + ')');
    });
    lines.push('');
    lines.push('Refer to these attachments naturally in your reply. Never quote internal slugs, file paths, or URLs.');
    return lines.join('\n');
}

// ── Type-specific interpreters ───────────────────────────────────

async function _interpretImage(url, name) {
    // Reuse the runtime's existing vision pipeline by POSTing to itself.
    // (Internal HTTP call is fine — same process, localhost loopback.)
    const port = process.env.PORT || 3000;
    const secret = process.env.WP_SECRET || process.env.LU_SECRET || process.env.RUNTIME_SECRET;
    try {
        const resp = await axios.post(
            `http://127.0.0.1:${port}/internal/vision/analyze`,
            { prompt: VISION_PROMPT_DEFAULT, image_url: url },
            {
                timeout: 90000,
                headers: secret ? { 'X-LevelUp-Secret': secret } : {},
            }
        );
        const desc = (resp.data && resp.data.analysis) || '';
        return {
            ok: true,
            kind: 'image',
            name,
            summary: name ? `An image: ${name}` : 'An image',
            vision_describe: _truncate(desc, MAX_EXTRACTED_CHARS),
        };
    } catch (err) {
        // Vision failing isn't fatal — fall back to a clear acknowledgement.
        return {
            ok: true,
            kind: 'image',
            name,
            summary: name ? `An image: ${name} (vision not available right now)` : 'An image (vision not available right now)',
            error: (err.response && err.response.status) ? `vision ${err.response.status}` : (err.message || 'vision failed'),
        };
    }
}

async function _interpretPdf(url, name) {
    const pdfParse = require('pdf-parse');
    const buf = await _downloadToBuffer(url);
    const data = await pdfParse(buf, { max: 30 }); // up to 30 pages
    const text = (data && data.text) ? data.text.replace(/\s+/g, ' ').trim() : '';
    return {
        ok: true,
        kind: 'document',
        name,
        summary: `A PDF (${data.numpages || '?'} pages${name ? ', ' + name : ''})`,
        extracted_text: _truncate(text, MAX_EXTRACTED_CHARS),
    };
}

async function _interpretDocx(url, name) {
    const mammoth = require('mammoth');
    const buf = await _downloadToBuffer(url);
    const result = await mammoth.extractRawText({ buffer: buf });
    const text = (result && result.value) ? result.value.replace(/\s+\n/g, '\n').trim() : '';
    return {
        ok: true,
        kind: 'document',
        name,
        summary: name ? `A Word document: ${name}` : 'A Word document',
        extracted_text: _truncate(text, MAX_EXTRACTED_CHARS),
    };
}

async function _interpretXlsx(url, name) {
    const XLSX = require('xlsx');
    const buf = await _downloadToBuffer(url);
    const wb = XLSX.read(buf, { type: 'buffer' });
    const sheets = wb.SheetNames || [];
    const previewBlocks = [];

    for (const sheetName of sheets.slice(0, 5)) { // up to 5 sheets
        const sheet = wb.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        if (!rows.length) continue;
        const header = rows[0];
        const sample = rows.slice(0, 50);
        const md = _rowsToMarkdownTable(sample);
        previewBlocks.push(`Sheet "${sheetName}" (${rows.length} rows × ${header.length} cols):\n${md}`);
    }

    const joined = previewBlocks.join('\n\n');
    return {
        ok: true,
        kind: 'document',
        name,
        summary: `A spreadsheet (${sheets.length} sheet${sheets.length === 1 ? '' : 's'}${name ? ', ' + name : ''})`,
        extracted_text: _truncate(joined, MAX_EXTRACTED_CHARS),
    };
}

async function _interpretText(url, name) {
    const buf = await _downloadToBuffer(url);
    const text = buf.toString('utf8').trim();
    return {
        ok: true,
        kind: 'document',
        name,
        summary: name ? `A text file: ${name}` : 'A text file',
        extracted_text: _truncate(text, MAX_EXTRACTED_CHARS),
    };
}

// ── Helpers ──────────────────────────────────────────────────────

async function _downloadToBuffer(url) {
    const resp = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: DOWNLOAD_TIMEOUT_MS,
        maxContentLength: MAX_REMOTE_BYTES,
        maxBodyLength: MAX_REMOTE_BYTES,
    });
    return Buffer.from(resp.data);
}

function _kindFromMime(mime, name) {
    if (!mime && !name) return 'unknown';
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    return 'document';
}

function _ext(name) {
    if (!name) return '';
    const parts = String(name).toLowerCase().split('.');
    return parts.length > 1 ? parts.pop() : '';
}

function _truncate(s, max) {
    s = String(s || '');
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
}

function _oneLine(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
}

function _indent(s, prefix) {
    return String(s || '').split('\n').map(l => prefix + l).join('\n');
}

function _rowsToMarkdownTable(rows) {
    if (!rows.length) return '(empty)';
    const cols = Math.max(...rows.map(r => r.length));
    const pad = (cell) => String(cell ?? '').replace(/\|/g, '/').slice(0, 60);
    const header = rows[0].slice(0, cols).map(pad);
    const sep = header.map(() => '---');
    const lines = [
        '| ' + header.join(' | ') + ' |',
        '| ' + sep.join(' | ') + ' |',
    ];
    for (let i = 1; i < rows.length; i++) {
        const r = rows[i].slice(0, cols).map(pad);
        while (r.length < header.length) r.push('');
        lines.push('| ' + r.join(' | ') + ' |');
    }
    return lines.join('\n');
}

module.exports = {
    interpretOne,
    interpretMany,
    formatForPrompt,
};
