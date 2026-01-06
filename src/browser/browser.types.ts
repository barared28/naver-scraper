import { Browser } from 'puppeteer';

export interface PooledBrowser {
    browser: Browser;
    inUse: boolean;
    lastUsedAt: number;
    lastPreparedAt: number;
    isPrepared: boolean;
    proxy: string;
}

export interface WaitingRequest {
    resolve: (browser: Browser) => void;
    reject: (error: Error) => void;
    timestamp: number;
    timeout: NodeJS.Timeout;
}