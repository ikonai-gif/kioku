import { Component, type ReactNode } from 'react';

interface Props { children: ReactNode; }
interface State { error: Error | null; }

// Catches render / lazy-chunk errors in the route tree so a single failing
// route shows a recoverable card instead of blanking the whole app. Lazy
// routes without a boundary unmount the entire tree on any throw.
export default class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('[RouteErrorBoundary]', error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className='flex h-screen flex-col items-center justify-center gap-4 bg-background p-6 text-center'>
          <div className='text-lg font-semibold text-foreground'>Страница не открылась</div>
          <pre className='max-w-lg overflow-auto rounded-lg bg-white/5 p-3 text-left text-xs text-red-300'>{this.state.error.message}</pre>
          <button onClick={() => window.location.reload()} className='rounded-lg border border-primary/30 bg-primary/15 px-4 py-2 text-sm text-primary hover:bg-primary/25'>Перезагрузить</button>
        </div>
      );
    }
    return this.props.children;
  }
}
