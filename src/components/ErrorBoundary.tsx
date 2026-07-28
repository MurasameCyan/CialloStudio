import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = {
  children: ReactNode;
  label?: string;
};

type State = {
  error: Error | null;
};

/** 防止子树抛错导致整页白/黑屏 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[Ciallo] ${this.props.label || "UI"} crashed`, error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="page" style={{ padding: 16 }}>
          <section className="panel">
            <div className="panel-kicker">Error</div>
            <h2 className="panel-title">{this.props.label || "页面"}出错</h2>
            <p className="panel-desc" style={{ maxWidth: "none" }}>
              {this.state.error.message || String(this.state.error)}
            </p>
            <div className="btn-row" style={{ marginTop: 16 }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => this.setState({ error: null })}
              >
                重试
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  try {
                    localStorage.removeItem("ciallo-studio.settings.v1");
                    localStorage.removeItem("ciallo-studio.jobs.v1");
                    localStorage.removeItem("ciallo-studio.draft.v1");
                    localStorage.removeItem("ciallo-studio.jobs.v2");
                    localStorage.removeItem("ciallo-studio.draft.v2");
                  } catch {
                    // ignore
                  }
                  window.location.reload();
                }}
              >
                清除缓存并刷新
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => window.location.reload()}
              >
                刷新页面
              </button>
            </div>
          </section>
        </div>
      );
    }
    return this.props.children;
  }
}
