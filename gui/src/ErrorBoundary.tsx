import { Component, type ErrorInfo, type ReactNode } from 'react';
import i18n from './i18n';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

// 渲染期出错时,显示可读的错误而不是整屏白屏(白屏会让问题极难定位)。
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('skill-switch GUI 渲染错误:', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <pre
          style={{
            color: '#f88',
            padding: '24px',
            whiteSpace: 'pre-wrap',
            font: '13px ui-monospace, monospace',
          }}
        >
          {`${i18n.t('errorBoundary.message')}\n\n${this.state.error.message}\n\n${this.state.error.stack ?? ''}`}
        </pre>
      );
    }
    return this.props.children;
  }
}
