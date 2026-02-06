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

    // Cohere API Key Type (trial vs production)
    getCohereKeyType: () => ipcRenderer.invoke('get-cohere-key-type'),
    setCohereKeyType: (keyType: 'trial' | 'production') => ipcRenderer.invoke('set-cohere-key-type', keyType),

    // Utilities
    openExternal: (url: string) => ipcRenderer.invoke('open-external', url),

    // Progress Listener
    onProgress: (callback: (data: { current: number; total: number; percent: number }) => void) => {
        const subscription = (_: any, data: any) => callback(data);
        ipcRenderer.on('briefing-progress', subscription);
        // Return unsubscribe function
        return () => ipcRenderer.removeListener('briefing-progress', subscription);
    },

    // Card Generated Listener
    onCardGenerated: (callback: (card: any) => void) => {
        const subscription = (_: any, card: any) => callback(card);
        ipcRenderer.on('briefing-card-generated', subscription);
        return () => ipcRenderer.removeListener('briefing-card-generated', subscription);
    }
});
