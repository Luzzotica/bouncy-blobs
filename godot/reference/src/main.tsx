import ReactDOM from 'react-dom/client';
import { StrictMode } from 'react';
import './index.css';
import App from './App.tsx';
import { UserProvider } from './contexts/UserContext.tsx';

// Unregister any existing service workers (especially stale ones from previous deployments)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const registration of registrations) {
      registration.unregister().then((success) => {
        if (success) {
          console.log('Service worker unregistered');
        }
      });
    }
  });
  
  // Also try to unregister by scope
  navigator.serviceWorker.getRegistration().then((registration) => {
    if (registration) {
      registration.unregister().then((success) => {
        if (success) {
          console.log('Service worker unregistered by scope');
        }
      });
    }
  });
}

// Global error handler to catch unhandled module import errors
window.addEventListener('error', (event) => {
  // Suppress MIME type errors from dynamic imports (expected when files don't exist)
  if (event.message?.includes('MIME type') || 
      event.message?.includes('text/html') ||
      event.filename?.includes('game') ||
      event.filename?.includes('module')) {
    event.preventDefault();
    console.debug('Suppressed module import error:', event.message);
    return false;
  }
});

// Also catch unhandled promise rejections
window.addEventListener('unhandledrejection', (event) => {
  const errorMessage = event.reason?.message || String(event.reason);
  if (errorMessage?.includes('MIME type') || 
      errorMessage?.includes('text/html') ||
      errorMessage?.includes('Failed to fetch module') ||
      errorMessage?.includes('service-worker') ||
      errorMessage?.includes('serviceWorker') ||
      errorMessage?.includes('Failed to fetch')) {
    // Suppress service worker and module import errors
    if (errorMessage?.includes('service-worker') || errorMessage?.includes('serviceWorker')) {
      console.debug('Suppressed service worker error:', errorMessage);
    } else {
      console.debug('Suppressed module import rejection:', errorMessage);
    }
    event.preventDefault();
    return false;
  }
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <UserProvider>
      <App />
    </UserProvider>
  </StrictMode>,
);
