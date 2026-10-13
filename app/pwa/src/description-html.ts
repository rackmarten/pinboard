// I17: descriptions are authored as markdown by DescriptionEditor.vue.
// Rendering parses that markdown to HTML and sanitizes it before v-html.
// `marked`'s GFM mode passes raw inline HTML in the source straight through
// to its output, so pre-I17 HTML descriptions (written via I11's since-removed
// Tiptap WYSIWYG editor) keep rendering correctly too - no separate legacy
// path or conversion needed. `breaks: true` keeps a single newline in plain
// prose rendering as a line break, matching the pre-I11 plain-text behavior.
import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: true });

// I18: #<id> anywhere in a description/comment/project context links to that
// task - lets project context reference specific tasks instead of restating
// their history. Matches word-boundary #123, not inside a longer token like
// a URL fragment or a hex color, and not a markdown heading (those start a
// line with "#", never appear mid-text where this token does).
marked.use({
  extensions: [
    {
      name: "taskRef",
      level: "inline",
      start(src: string) {
        return src.match(/#\d+/)?.index;
      },
      tokenizer(src: string) {
        const match = /^#(\d+)\b/.exec(src);
        if (!match) return undefined;
        return {
          type: "taskRef",
          raw: match[0],
          taskId: match[1],
        };
      },
      renderer(token) {
        const taskId = (token as unknown as { taskId: string }).taskId;
        return `<a href="/tasks/${taskId}">#${taskId}</a>`;
      },
    },
  ],
});

const ALLOWED_TAGS = [
  "p",
  "br",
  "strong",
  "em",
  "s",
  "code",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "a",
  "h1",
  "h2",
  "h3",
  "h4",
  "hr",
];

export function renderDescriptionHtml(markdown: string): string {
  const html = marked.parse(markdown, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ["href", "target", "rel"],
  });
}
