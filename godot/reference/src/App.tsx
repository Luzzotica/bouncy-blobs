import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Component, ReactNode } from "react";
import { Home } from "./pages/Home";
import GameMaster from "./pages/GameMaster";
import { Controller } from "./pages/Controller";
import { Auth } from "./pages/Auth";
import "./index.css";

// Simple Error Boundary Component
class ErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    // Suppress MIME type errors - they're expected when modules don't exist
    if (error.message?.includes('MIME type') || 
        error.message?.includes('text/html') ||
        error.message?.includes('Failed to fetch module')) {
      // Don't show error boundary for these - just log and continue
      console.debug('Suppressed module import error in ErrorBoundary:', error.message);
      return { hasError: false, error: null };
    }
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: any) {
    // Suppress MIME type errors
    if (error.message?.includes('MIME type') || 
        error.message?.includes('text/html')) {
      console.debug('Suppressed module import error:', error.message);
      this.setState({ hasError: false, error: null });
      return;
    }
    console.error('Error caught by boundary:', error, errorInfo);
  }

  render() {
    if (this.state.hasError && this.state.error) {
      return (
        <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center p-4">
          <div className="bg-red-600/20 border border-red-500 rounded-lg p-6 max-w-md">
            <h1 className="text-2xl font-bold mb-4">Something went wrong</h1>
            <p className="text-red-200 mb-4">{this.state.error.message}</p>
            <button
              onClick={() => {
                this.setState({ hasError: false, error: null });
                window.location.href = '/';
              }}
              className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg"
            >
              Return to Home
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/auth" element={<Auth />} />
          <Route path="/game/:sessionId" element={<GameMaster />} />
          <Route path="/controller" element={<Controller />} />
          <Route path="/controller/:sessionId" element={<Controller />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  );
}

export default App;
