import { contextBridge, ipcRenderer } from 'electron';

// Secure IPC bridge - exposes only specific APIs to renderer
contextBridge.exposeInMainWorld('briefingAPI', {
    // Fetch and summarize emails
    fetchBriefing: () => ipcRenderer.invoke('fetch-briefing'),

    // Google OAuth
    signInWithGoogle: () => ipcRenderer.invoke('sign-in-google'),
    signOut: () => ipcRenderer.invoke('sign-out'),
    checkAuthStatus: () => ipcRenderer.invoke('check-auth-status'),

    // API Key management
    setApiKey: (key: string) => ipcRenderer.invoke('set-api-key', key),
    getApiKey: () => ipcRenderer.invoke('get-api-key'),

    // History
    getHistory: () => ipcRenderer.invoke('get-history'),
    clearHistory: () => ipcRenderer.invoke('clear-history'),

    // Accessibility Settings
    getSettings: () => ipcRenderer.invoke('get-settings'),
    setSettings: (settings: { accentColor: string; fontSize: number; animationsEnabled: boolean }) =>
        ipcRenderer.invoke('set-settings', settings),

    // Utilities
    openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
});
