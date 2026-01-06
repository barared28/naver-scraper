import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser } from 'puppeteer';
import { PooledBrowser, WaitingRequest } from './browser.types';

puppeteer.use(StealthPlugin());

@Injectable()
export class BrowserPoolService implements OnModuleInit, OnModuleDestroy {
    private pool: PooledBrowser[] = [];
    private maxBrowsers: number;    
    private waitingQueue: WaitingRequest[] = [];
    private maxWaitTime: number = 30000;
    private checkInterval: NodeJS.Timeout;
    private proxies: string[] = [];
    private BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN || '';
    private BROWSERLESS_URL = process.env.BROWSERLESS_URL || 'localhost:3000';
    private logger = new Logger(BrowserPoolService.name);

    constructor() {
        this.maxWaitTime = parseInt(process.env.MAX_WAIT_TIME || '30000', 10);
        this.proxies = JSON.parse(process.env.PROXIES || '[]');
        this.maxBrowsers = Math.min(
            parseInt(process.env.MAX_THREAD || '5', 10),
            this.proxies.length,
        );
    }

    async onModuleInit() {
        this.logger.log(`Initializing browser pool with ${this.maxBrowsers} browsers...`);

        for (const proxy of this.proxies) {
            const i = this.proxies.indexOf(proxy);
            if (i >= this.maxBrowsers) break;

            this.logger.log(`Using proxy: ${proxy}`);

            try {
                const [ip, port] = proxy.split(':');
                const launchArgs = {
                    headless: false,
                    args: [
                        `--proxy-server=http://${ip}:${port}`,
                        `--user-data-dir=~/u/naver-${Buffer.from(proxy).toString('base64')}`,
                    ],
                    defaultViewport: null,
                };

                const queryParams = new URLSearchParams({
                    token: this.BROWSERLESS_TOKEN,
                    timeout: '6000000',
                    launch: JSON.stringify(launchArgs),
                }).toString();

                const browserWSEndpoint = `ws://${this.BROWSERLESS_URL}?${queryParams}`;
                const browser = await puppeteer.connect({
                    browserWSEndpoint,
                    defaultViewport: null,
                    acceptInsecureCerts: true,
                });

                this.pool.push({
                    browser,
                    inUse: false,
                    lastUsedAt: Date.now(),
                    lastPreparedAt: 0,
                    isPrepared: false,
                    proxy,
                });

                this.logger.log(`Browser ${i + 1} connected`);
            } catch (error) {
                this.logger.error(`Failed to launch browser ${i + 1}:`, error);
            }
        }

        this.logger.log(`Pool initialized with ${this.pool.length} browsers`);

        // Cleanup timeout requests every 1 second
        this.checkInterval = setInterval(() => this.processWaitingQueue(), 1000);
    }

    async onModuleDestroy() {
        if (this.checkInterval) clearInterval(this.checkInterval);

        this.logger.log('Closing all browsers...');
        await Promise.all(this.pool.map(p => p.browser.close().catch(e => this.logger.error(e))));
        this.logger.log('All browsers closed');
    }

    async getBrowser(): Promise<Browser> {
        const availableBrowser = this.pool
            .sort((a, b) => a.lastUsedAt - b.lastUsedAt)
            .find(p => !p.inUse);

        if (availableBrowser) {
            this.logger.log(`Using browser with proxy: ${availableBrowser.proxy}`);
            availableBrowser.inUse = true;
            availableBrowser.lastUsedAt = Date.now();
            return availableBrowser.browser;
        }

        // wait for browser to be available
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                const index = this.waitingQueue.findIndex(w => w.reject === reject);
                if (index !== -1) {
                    this.waitingQueue.splice(index, 1);
                }
                reject(new Error(`Timeout waiting for browser (${this.maxWaitTime}ms)`));
            }, this.maxWaitTime);

            this.waitingQueue.push({
                resolve,
                reject,
                timestamp: Date.now(),
                timeout,
            });

            this.logger.log(`Request waiting for browser. Queue: ${this.waitingQueue.length}`);
        });
    }

    async getBrowserWithTimeout(timeoutMs: number): Promise<Browser> {
        const availableBrowser = this.pool
            .sort((a, b) => a.lastUsedAt - b.lastUsedAt)
            .find(p => !p.inUse);

        if (availableBrowser) {
            this.logger.log(`Using browser with proxy: ${availableBrowser.proxy}`);
            availableBrowser.inUse = true;
            availableBrowser.lastUsedAt = Date.now();
            return availableBrowser.browser;
        }

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                const index = this.waitingQueue.findIndex(w => w.reject === reject);
                if (index !== -1) {
                    this.waitingQueue.splice(index, 1);
                }
                reject(new Error(`Timeout waiting for browser (${timeoutMs}ms)`));
            }, timeoutMs);

            this.waitingQueue.push({
                resolve,
                reject,
                timestamp: Date.now(),
                timeout,
            });
        });
    }

    releaseBrowser(browser: Browser): void {
        const pooledBrowser = this.pool.find(p => p.browser === browser);

        if (!pooledBrowser) {
            this.logger.warn('Tried to release unknown browser');
            return;
        }

        // if there are waiting requests, allocate browser to them
        if (this.waitingQueue.length > 0) {
            const waiter = this.waitingQueue.shift();
            clearTimeout(waiter!.timeout);
            waiter!.resolve(browser);
            this.logger.log(`Browser allocated to waiting request. Queue: ${this.waitingQueue.length}`);
        } else {
            pooledBrowser.inUse = false;
            pooledBrowser.lastUsedAt = Date.now();
            this.logger.log('Browser released');
        }
    }

    private processWaitingQueue(): void {
        const now = Date.now();
        const expired = this.waitingQueue.filter(w => now - w.timestamp > this.maxWaitTime);

        expired.forEach(w => {
            clearTimeout(w.timeout);
            w.reject(new Error(`Timeout waiting for browser (${this.maxWaitTime}ms)`));
        });

        this.waitingQueue = this.waitingQueue.filter(w => now - w.timestamp <= this.maxWaitTime);
    }

    // for browser warmer service
    getPooledBrowsers(): PooledBrowser[] {
        return this.pool;
    }

    updateBrowserPrepared(browser: Browser, isPrepared: boolean): void {
        const pooledBrowser = this.pool.find(p => p.browser === browser);
        if (pooledBrowser) {
            pooledBrowser.isPrepared = isPrepared;
            pooledBrowser.lastPreparedAt = Date.now();
        }
    }

    isPoolHealthy(): { healthy: boolean; idle: number; total: number } {
        const idle = this.pool.filter(p => !p.inUse).length;
        return {
            healthy: this.pool.length === this.maxBrowsers,
            idle,
            total: this.pool.length,
        };
    }

    notifyWarmupComplete(): void {
        this.logger.log('Warmup complete, pool ready for requests');
    }

    getExpectedBrowserCount(): number {
        return this.maxBrowsers;
    }
}