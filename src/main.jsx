import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import Admin from './Admin.jsx';
import './index.css';

// 路径路由：/admin 进管理台，其余进客户提词页
const isAdmin = window.location.pathname.startsWith('/admin');
const Component = isAdmin ? Admin : App;

createRoot(document.getElementById('root')).render(<Component />);
