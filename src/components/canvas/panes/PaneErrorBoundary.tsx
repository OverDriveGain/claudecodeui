import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  title: string;
  children: ReactNode;
}
interface State {
  failed: boolean;
}

/**
 * Contains a single pane's render errors so one bad pane never takes down the
 * whole canvas (or the app). Shows a small fallback in place of that pane.
 */
export default class PaneErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[canvas] pane "${this.props.title}" failed to render`, error, info);
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="flex h-full w-full flex-col overflow-hidden rounded-lg border border-border bg-card">
          <div className="border-b border-border px-3 py-1.5 text-xs font-medium text-muted-foreground">
            {this.props.title}
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center p-2">
            <div className="text-center text-xs text-muted-foreground/70">
              Couldn’t render this pane.
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
