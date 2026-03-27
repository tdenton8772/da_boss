import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-gray-950 flex items-center justify-center p-8">
          <div className="bg-red-950/30 border border-red-800 rounded-lg p-6 max-w-xl w-full">
            <h2 className="text-red-400 font-bold text-lg mb-2">Component Error</h2>
            <pre className="text-red-300 text-sm whitespace-pre-wrap break-words mb-4">
              {this.state.error.message}
            </pre>
            <pre className="text-red-400/50 text-xs whitespace-pre-wrap break-words max-h-48 overflow-auto">
              {this.state.error.stack}
            </pre>
            <button
              onClick={() => {
                this.setState({ error: null });
                window.location.href = "/";
              }}
              className="mt-4 px-4 py-2 bg-red-800 hover:bg-red-700 text-white rounded text-sm"
            >
              Back to Dashboard
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
