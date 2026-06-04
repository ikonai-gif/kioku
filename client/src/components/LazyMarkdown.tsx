import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Thin wrapper around react-markdown + remark-gfm, kept in its own module so it
 * can be React.lazy()-loaded. react-markdown pulls a large unified/micromark
 * stack (~400KB rendered); loading it lazily keeps it out of the partner-chat
 * page chunk. The `components` config stays in the caller (it references
 * caller-local components like CodeBlock/FileDownloadCard).
 */
export default function LazyMarkdown({
  content,
  components,
}: {
  content: string;
  components: Components;
}) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {content}
    </ReactMarkdown>
  );
}
