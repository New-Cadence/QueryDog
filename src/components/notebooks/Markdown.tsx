// Small markdown renderer for notebook text cells: headings, paragraphs,
// bullet and numbered lists, block quotes, rules, fenced code and inline
// bold / italic / code / links. Output is React elements, never raw HTML.
import type { ReactNode } from 'react';

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*(?!\s)[^*]+(?<!\s)\*|\[[^\]]+\]\([^)\s]+\))/g;

// Only allow ordinary links so a notebook can't smuggle in javascript: URLs.
const safeHref = (href: string) => (/^(https?:|mailto:|\/|#)/i.test(href) ? href : undefined);

function renderInline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const tok = m[0];
    const at = m.index;
    if (at > last) parts.push(text.slice(last, at));
    if (tok.startsWith('`')) parts.push(<code key={at} className="px-1 rounded bg-gray-800 text-blue-300 text-[0.9em]">{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('**')) parts.push(<strong key={at} className="text-white">{renderInline(tok.slice(2, -2))}</strong>);
    else if (tok.startsWith('*')) parts.push(<em key={at}>{renderInline(tok.slice(1, -1))}</em>);
    else {
      const [, label, href] = tok.match(/\[([^\]]+)\]\(([^)\s]+)\)/)!;
      parts.push(<a key={at} href={safeHref(href)} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">{label}</a>);
    }
    last = at + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

const HEADING_CLASS = ['text-xl font-bold', 'text-base font-semibold', 'text-sm font-semibold', 'text-xs font-semibold', 'text-xs font-semibold', 'text-xs font-semibold'];

export function Markdown({ source }: { source: string }) {
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let code: string[] | null = null;

  const flush = () => {
    if (paragraph.length) {
      blocks.push(<p key={blocks.length}>{renderInline(paragraph.join(' '))}</p>);
      paragraph = [];
    }
    if (list) {
      const items = list.items.map((l, i) => <li key={i}>{renderInline(l)}</li>);
      blocks.push(list.ordered
        ? <ol key={blocks.length} className="list-decimal pl-5 space-y-0.5">{items}</ol>
        : <ul key={blocks.length} className="list-disc pl-5 space-y-0.5">{items}</ul>);
      list = null;
    }
  };
  const pushCode = (lines: string[]) =>
    blocks.push(<pre key={blocks.length} className="bg-gray-950 border border-gray-700 rounded p-2 text-xs text-green-300 overflow-x-auto">{lines.join('\n')}</pre>);

  for (const line of source.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      if (code) { pushCode(code); code = null; } else { flush(); code = []; }
      continue;
    }
    if (code) { code.push(line); continue; }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push(<hr key={blocks.length} className="border-gray-700" />);
      continue;
    }
    const item = line.match(/^\s*(?:([-*+])|(\d+)[.)])\s+(.*)/);
    if (item) {
      const ordered = !item[1];
      if (paragraph.length || (list && list.ordered !== ordered)) flush();
      list = list || { ordered, items: [] };
      list.items.push(item[3]);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)/);
    if (heading) {
      flush();
      const level = heading[1].length;
      const Tag = `h${level}` as 'h1';
      blocks.push(<Tag key={blocks.length} className={`${HEADING_CLASS[level - 1]} text-white`}>{renderInline(heading[2])}</Tag>);
    } else if (line.startsWith('>')) {
      flush();
      blocks.push(<blockquote key={blocks.length} className="border-l-2 border-blue-500 pl-3 text-gray-400">{renderInline(line.replace(/^>\s?/, ''))}</blockquote>);
    } else if (line.trim()) {
      if (list) flush();
      paragraph.push(line.trim());
    } else {
      flush();
    }
  }
  flush();
  if (code) pushCode(code); // unterminated fence: still show what was typed
  return <div className="space-y-2 text-sm text-gray-300">{blocks}</div>;
}
