import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { ThemeProvider } from './components/ThemeProvider';
import { TooltipProvider } from './components/ui/tooltip';
import './i18n';
import './styles.css';

// Tauri 本地 IPC 推荐配置:5 分钟 stale、1 次重试、不监听窗口焦点
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 300_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const root = document.getElementById('root');

if (!root) {
  throw new Error('Root element #root was not found.');
}

createRoot(root).render(
  <React.StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={300}>
          <ErrorBoundary>
            <App />
          </ErrorBoundary>
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
