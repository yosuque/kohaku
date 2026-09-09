import { Component, type ErrorInfo, type ReactNode } from "react";

interface NodeErrorBoundaryProps {
  /** The node currently being rendered (the entity, not an ID reference). When swapped, reset state and retry. */
  node: unknown;
  /** Fallback to render when caught. */
  fallback: (error: unknown) => ReactNode;
  /** Callback on catch (called once from componentDidCatch). */
  onError?: (error: unknown) => void;
  children: ReactNode;
}

interface NodeErrorBoundaryState {
  hasError: boolean;
  error: unknown;
}

/**
 * Per-node error boundary. Even if an exception is thrown while rendering one component, the sibling nodes and
 * the entire surface stay alive, and only that node is swapped to a fallback display.
 *
 * Note (React's design): only exceptions thrown synchronously "during rendering (render / lifecycle)" can be caught.
 * Exceptions thrown on async paths such as inside event handlers, setTimeout, or Promises cannot be caught
 * (a constraint of React's error boundaries).
 *
 * If a Spec swap makes the node a different instance, componentDidUpdate resets state and automatically
 * retries (it can recover when a fixed Spec arrives).
 */
export class NodeErrorBoundary extends Component<NodeErrorBoundaryProps, NodeErrorBoundaryState> {
  constructor(props: NodeErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: unknown): NodeErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: unknown, _info: ErrorInfo): void {
    this.props.onError?.(error);
  }

  componentDidUpdate(prevProps: NodeErrorBoundaryProps): void {
    if (this.state.hasError && prevProps.node !== this.props.node) {
      this.setState({ hasError: false, error: null });
    }
  }

  render(): ReactNode {
    if (this.state.hasError) return this.props.fallback(this.state.error);
    return this.props.children;
  }
}
