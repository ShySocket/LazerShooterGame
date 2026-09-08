import { Component, type ReactNode } from 'react';
import { recordIncident } from './diag';

interface State {
  error: Error | null;
}

/** Keeps a crash on screen with its message instead of unmounting to a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    recordIncident('error', `${error.message}\n${error.stack ?? ''}`);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="screen center">
        <div className="label">Something broke</div>
        <p className="sub">{this.state.error.message}</p>
        <p className="hint">The details were saved. Reloading takes you back into your room.</p>
        <button className="btn primary" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
