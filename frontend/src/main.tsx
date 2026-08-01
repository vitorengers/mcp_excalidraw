// First, and it has to stay first: it takes the board token out of the address bar and wraps
// `window.fetch` before anything else can call it. `WorkspaceDialogs.tsx` fetches at module
// scope, so "before the first render" would already be too late. See ./auth.ts.
import './auth'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import '@excalidraw/excalidraw/index.css'

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)