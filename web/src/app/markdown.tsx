import type { ComponentChildren, VNode } from 'preact';

/**
 * A small Markdown renderer for model READMEs. It builds Preact elements and
 * never sets HTML, so anything in a README (HTML included) can only ever be text.
 *
 * Covered: headings, paragraphs, lists, block quotes, fenced code, rules, tables
 * (shown as preformatted text), emphasis, inline code, links and images. Links
 * open only http(s). Images load only from CommunityCAD's own storage: any other
 * host would see every visitor to the printer, so those become links.
 */

/** Where model pictures are stored. Only these load inline. */
const OWN_IMAGES = /^https:\/\/storage\.googleapis\.com\/communitycad-assets\//;

const isWeb = (url: string) => /^https?:\/\//i.test(url);

/** Raw HTML tags are dropped, keeping their text; a <br> becomes a space. */
function stripTags(text: string): string {
  return text.replace(/<br\s*\/?>/gi, ' ').replace(/<\/?[a-z][^>]*>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
}

function inline(text: string, key = 'i'): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  // Order matters: code first (nothing inside it is Markdown), then images, links,
  // bare URLs, bold, italic. No _underscore_ italics: they'd need a lookbehind, which
  // older iPhone Safari can't parse, and READMEs are full of snake_case.
  const pattern = /(`+)([^`]+?)\1|!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|<?(https?:\/\/[^\s<>)]+)>?|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*?)\*/g;
  let last = 0;
  let n = 0;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${n++}`;
    if (m[2] !== undefined) {
      out.push(<code key={k}>{m[2]}</code>);
    } else if (m[4] !== undefined) {
      const [alt, src] = [m[3], m[4]];
      out.push(OWN_IMAGES.test(src)
        ? <img key={k} src={src} alt={alt} decoding="async" />
        : isWeb(src) ? <a key={k} href={src} target="_blank" rel="noreferrer noopener">{alt || 'image'}</a> : alt);
    } else if (m[6] !== undefined) {
      out.push(isWeb(m[6])
        ? <a key={k} href={m[6]} target="_blank" rel="noreferrer noopener">{inline(m[5], k)}</a>
        : inline(m[5], k));
    } else if (m[7] !== undefined) {
      out.push(<a key={k} href={m[7]} target="_blank" rel="noreferrer noopener">{m[7]}</a>);
    } else if (m[8] !== undefined || m[9] !== undefined) {
      out.push(<strong key={k}>{inline(m[8] ?? m[9], k)}</strong>);
    } else {
      out.push(<em key={k}>{inline(m[10], k)}</em>);
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** README Markdown as Preact elements, block by block. */
export function renderMarkdown(source: string): VNode[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: VNode[] = [];
  let i = 0;
  const k = () => `b${blocks.length}`;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i]);
      i++;
      blocks.push(<pre key={k()}><code>{body.join('\n')}</code></pre>);
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      const level = Math.min(6, heading[1].length + 2);   // README h1 sits under the page's title
      const H = `h${level}` as 'h3';
      blocks.push(<H key={k()}>{inline(stripTags(heading[2]))}</H>);
      i++;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { blocks.push(<hr key={k()} />); i++; continue; }
    if (/^\s*\|/.test(line)) {
      const rows: string[] = [];
      for (; i < lines.length && /^\s*\|/.test(lines[i]); i++) {
        if (!/^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i])) rows.push(lines[i].trim());
      }
      blocks.push(<pre key={k()} class="md-table">{rows.map((r) => stripTags(r)).join('\n')}</pre>);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s*>\s?/, ''));
      blocks.push(<blockquote key={k()}>{renderMarkdown(quote.join('\n'))}</blockquote>);
      continue;
    }
    const bullet = /^\s*([-*+]|\d+[.)])\s+/;
    if (bullet.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      for (; i < lines.length && (bullet.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length)); i++) {
        if (bullet.test(lines[i])) items.push(lines[i].replace(bullet, ''));
        else items[items.length - 1] += ` ${lines[i].trim()}`;
      }
      const L = ordered ? 'ol' : 'ul';
      blocks.push(<L key={k()}>{items.map((t, j) => <li key={j}>{inline(stripTags(t), `${k()}-${j}`)}</li>)}</L>);
      continue;
    }
    // A paragraph, or a setext heading when underlined with === or ---.
    const start = i;
    const para: string[] = [];
    for (; i < lines.length && lines[i].trim() && !/^\s*(```|~~~|#{1,6}\s|>|\|)/.test(lines[i])
      && !(para.length && bullet.test(lines[i])); i++) {
      if (para.length && /^\s*(=+|-+)\s*$/.test(lines[i])) {
        const H = /=/.test(lines[i]) ? 'h3' : 'h4';
        blocks.push(<H key={k()}>{inline(stripTags(para.join(' ')))}</H>);
        para.length = 0;
        i++;
        break;
      }
      para.push(lines[i].trim());
    }
    if (i === start) para.push(lines[i++].trim());   // always move on, whatever the line
    if (para.length) {
      const text = stripTags(para.join(' ')).trim();
      if (text) blocks.push(<p key={k()}>{inline(text)}</p>);
    }
  }
  return blocks;
}
