import { Markdown } from '../../chat/view/subcomponents/Markdown';

interface FreePaneProps {
  content?: string;
  title?: string;
}

/**
 * Free pane — renders free-form markdown pushed via update_canvas `free`.
 * Reuses the shared Markdown wrapper (react-markdown) so styling matches chat.
 */
export default function FreePane({ content, title = 'Notes' }: FreePaneProps) {
  if (!content) {
    return (
      <div className="flex h-full w-full items-center justify-center rounded-lg border border-dashed border-border bg-muted/20 p-4">
        <div className="text-center">
          <div className="text-sm font-medium text-muted-foreground">{title}</div>
          <div className="mt-1 text-xs text-muted-foreground/70">No content yet</div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-auto rounded-lg border border-border bg-card p-4">
      <Markdown className="prose prose-sm max-w-none dark:prose-invert">
        {content}
      </Markdown>
    </div>
  );
}
