import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import Admin from './Admin';
import Redeem from './Redeem';
import ErrorBoundary from './ErrorBoundary';
import './styles.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary>{window.location.pathname.startsWith('/admin') ? <Admin/> : window.location.pathname === '/redeem' ? <Redeem/> : <App/>}</ErrorBoundary></React.StrictMode>);
