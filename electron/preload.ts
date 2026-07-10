import { contextBridge, ipcRenderer } from 'electron';

// Secure IPC bridge - exposes only specific APIs to renderer
contextBridge.exposeInMainWorld('briefingAPI', {
    // Fetch and build the dashboard briefing
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

    // Appearance / reader settings
    getSettings: () => ipcRenderer.invoke('get-settings'),
    setSettings: (settings: Record<string, unknown>) =>
        ipcRenderer.invoke('set-settings', settings),

    // Cohere API Key Type (trial vs production)
    getCohereKeyType: () => ipcRenderer.invoke('get-cohere-key-type'),
    setCohereKeyType: (keyType: 'trial' | 'production') => ipcRenderer.invoke('set-cohere-key-type', keyType),

    // Utilities
    openExternal: (url: string) => ipcRenderer.invoke('open-external', url),

    // Progress Listener
    onProgress: (callback: (data: { stage: string; message: string; current: number; total: number; percent: number }) => void) => {
        const subscription = (_: any, data: any) => callback(data);
        ipcRenderer.on('briefing-progress', subscription);
        return () => ipcRenderer.removeListener('briefing-progress', subscription);
    },

    // Dashboard streaming listener
    onDashboardGenerated: (callback: (dashboard: any) => void) => {
        const subscription = (_: any, dashboard: any) => callback(dashboard);
        ipcRenderer.on('dashboard-generated', subscription);
        return () => ipcRenderer.removeListener('dashboard-generated', subscription);
    }
});
