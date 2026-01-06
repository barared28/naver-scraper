import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { newInjectedPage } from 'fingerprint-injector';
import { FingerprintGenerator } from 'node_modules/fingerprint-generator/fingerprint-generator';
import puppeteer from "puppeteer-extra"
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { Browser, Page } from "puppeteer";
import { CaptchaSolverService } from './captcha-solver.service';

puppeteer.use(StealthPlugin());

interface PooledBrowser {
    browser: Browser;
    inUse: boolean;
    lastUsedAt: number;
    lastPreparedAt: number;
    isPrepared: boolean;
    proxy: string;
}

interface WaitingRequest {
    resolve: (browser: Browser) => void;
    reject: (error: Error) => void;
    timestamp: number;
    timeout: NodeJS.Timeout;
}

const generator = new FingerprintGenerator({
    devices: ['desktop'],
    operatingSystems: ['linux'],
    browsers: ['chrome'],
    // locales: ['ko-KR'],
    screen: {
        maxHeight: 1080,
        maxWidth: 1920,
        minHeight: 1080,
        minWidth: 1920,
    },
    httpVersion: '2',
});
const fingerprint = generator.getFingerprint();

@Injectable()
export class BrowserPoolService implements OnModuleInit, OnModuleDestroy {
    private pool: PooledBrowser[] = [];
    private maxBrowsers: number;
    private waitingQueue: WaitingRequest[] = [];
    private maxWaitTime: number = 30000; // 30 detik
    private checkInterval: NodeJS.Timeout;
    private prepareInterval: NodeJS.Timeout;
    private prepareIntervalTime: number = 5 * 60 * 1000; // 5 menit
    private isPreparing: boolean = false;
    private proxies: string[] = [];
    private BROWSERLESS_TOKEN = 'opoaeoleh'
    private BROWSERLESS_URL = process.env.BROWSERLESS_URL || 'localhost:3000';

    constructor(private readonly captchaSolverService: CaptchaSolverService) {
        this.maxWaitTime = parseInt(process.env.MAX_WAIT_TIME || '30000', 10);
        this.prepareIntervalTime = parseInt(process.env.PREPARE_INTERVAL || '300000', 10);
        this.proxies = JSON.parse(process.env.PROXIES || '[]');
        this.maxBrowsers = Math.min(parseInt(process.env.MAX_THREAD || '5', 10), this.proxies.length);
    }

    async onModuleInit() {
        console.log(`Initializing browser pool with ${this.maxBrowsers} browsers...`);

        for (const proxy of this.proxies) {
            const i = this.proxies.indexOf(proxy);
            if (i >= this.maxBrowsers) {
                continue;
            }
            console.log(`Using proxy: ${proxy}`);
            try {
                const [ip, port] = proxy.split(':');
                // const browser = await puppeteer.launch({
                //     headless: false,
                //     args: [
                //         '--no-sandbox',
                //         '--disable-setuid-sandbox',
                //         '--disable-dev-shm-usage',
                //         `--proxy-server=${ip}:${port}`,
                //     ],
                //     defaultViewport: null,
                // });
                // const launchArgs = {
                //     headless: false,
                //     args: [ `--proxy-server=http://${ip}:${port}`],
                //     // args: [`--user-data-dir=~/u/naver-${i}`],
                //     // defaultViewport: {
                //     //     width: 1920,
                //     //     height: 1080,
                //     // },
                //     defaultViewport: null,
                // };
                // const queryParams = new URLSearchParams({
                //     token: this.BROWSERLESS_TOKEN,
                //     timeout: "6000000",
                //     launch: JSON.stringify(launchArgs)
                // }).toString();
                // const browserWSEndpoint = `ws://${this.BROWSERLESS_URL}?${queryParams}`;
                // const browser = await puppeteer.connect({
                //     browserWSEndpoint,
                //     // defaultViewport: {
                //     //     width: 1920,
                //     //     height: 1080,
                //     // },
                //     defaultViewport: null,
                // });
                const browser = await puppeteer.launch({
                    headless: true,
                    args: [
                        `--proxy-server=http://${ip}:${port}`,
                        // '--disable-gpu',
                        // '--disable-dev-shm-usage',
                        // '--disable-setuid-sandbox',
                        '--no-sandbox',
                        // ssl
                        '--ignore-certificate-errors',
                        // user data dir
                        `--user-data-dir=~/u/naver-${ip}`,
                    ],
                    // args: [`--user-data-dir=~/u/naver-${i}`],
                    // defaultViewport: {
                    //     width: 1920,
                    //     height: 1080,
                    // },
                    defaultViewport: null,
                });
                this.pool.push({
                    browser,
                    inUse: false,
                    lastUsedAt: Date.now(),
                    lastPreparedAt: 0,
                    isPrepared: false,
                    proxy,
                });
            } catch (error) {
                console.error(`Failed to launch browser ${i + 1}:`, error);
            }
        }

        console.log(`Browser pool initialized with ${this.pool.length} browsers`);

        // Prepare semua browser saat startup
        await this.prepareAllBrowsers();

        // Periodic check untuk cleanup timeout requests
        this.checkInterval = setInterval(() => this.processWaitingQueue(), 1000);

        // Periodic prepare setiap 5 menit
        this.prepareInterval = setInterval(
            () => this.prepareAllBrowsers(),
            this.prepareIntervalTime,
        );

        console.log(`Prepare interval set to ${this.prepareIntervalTime}ms (${this.prepareIntervalTime / 60000} minutes)`);
    }

    async onModuleDestroy() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
        }
        if (this.prepareInterval) {
            clearInterval(this.prepareInterval);
        }
        console.log('Closing all browsers...');
        await Promise.all(this.pool.map(p => p.browser.close()));
        console.log('All browsers closed');
    }

    // Method untuk prepare browser
    private async prepareBrowser(pooledBrowser: PooledBrowser): Promise<boolean> {
        try {
            console.log(`[PREPARE] Preparing browser...`);

            const oldPages = await pooledBrowser.browser.pages();

            const page = await newInjectedPage(pooledBrowser.browser, {
                fingerprint,
            });
            // set viewport
            await page.setViewport({
                width: 1920,
                height: 1080,
            });

            await Promise.all(oldPages.map(page => page.close()));

            const [ip, port, username, password] = pooledBrowser.proxy.split(':');

            // authenticate with proxy
            await page.authenticate({
                username,
                password,
            });

            // set user agent
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.54 Safari/537.36');

            // Navigate ke blank page untuk warm up
            await this.gotoWithCaptchaSolver(page, "https://naver.com");
            await this.gotoWithCaptchaSolver(page, "https://shopping.naver.com/ns/home");

            // check ip https://api64.ipify.org?format=json use evaluate
            const ipResult = await page.evaluate(() => fetch('https://api64.ipify.org?format=json').then(res => res.json()));
            console.log(`[PREPARE] Check IP: ${ipResult.ip}`);


            // screenshot
            await page.screenshot({
                path: `naver-${new Date().toISOString().replace(/:/g, '-')}.png`,
                fullPage: true,
            })

            pooledBrowser.isPrepared = true;
            pooledBrowser.lastPreparedAt = Date.now();

            console.log(`[PREPARE] Browser prepared successfully`);
            return true;
        } catch (error) {
            console.error(`[PREPARE] Failed to prepare browser:`, error.message);
            pooledBrowser.isPrepared = false;
            return false;
        }
    }

    // Prepare semua browser di pool
    private async prepareAllBrowsers(): Promise<void> {
        if (this.isPreparing) {
            console.log('[PREPARE] Already preparing, skipping...');
            return;
        }

        this.isPreparing = true;
        console.log(`[PREPARE] Starting prepare cycle for all ${this.pool.length} browsers...`);

        const results = await Promise.allSettled(
            this.pool.map(pb => this.prepareBrowser(pb))
        );

        const successful = results.filter(r => r.status === 'fulfilled' && r.value).length;
        console.log(`[PREPARE] Prepare cycle complete: ${successful}/${this.pool.length} browsers prepared`);

        this.isPreparing = false;
    }

    // Prepare browser saat sedang tidak dipakai (background)
    private async prepareIfNeeded(pooledBrowser: PooledBrowser): Promise<void> {
        const now = Date.now();
        const timeSinceLastPrepare = now - pooledBrowser.lastPreparedAt;

        // Jika belum pernah di-prepare atau sudah > 5 menit, prepare sekarang
        if (!pooledBrowser.isPrepared || timeSinceLastPrepare > this.prepareIntervalTime) {
            await this.prepareBrowser(pooledBrowser);
        }
    }

    // Opsi 1: TUNGGU SAMPAI DAPAT
    async getBrowser(): Promise<Browser> {
        const availableBrowser = this.pool.sort((a, b) => a.lastUsedAt - b.lastUsedAt).find(p => !p.inUse);

        if (availableBrowser) {
            // log which proxy
            console.log(`[GET] Using browser with proxy: ${availableBrowser.proxy}`);
            // Ensure browser is prepared before returning
            await this.prepareIfNeeded(availableBrowser);

            availableBrowser.inUse = true;
            availableBrowser.lastUsedAt = Date.now();
            return availableBrowser.browser;
        }

        // Tunggu sampai ada browser yang available
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

            console.log(`Request waiting for browser. Queue length: ${this.waitingQueue.length}`);
        });
    }

    // Opsi 2: TUNGGU DENGAN CUSTOM TIMEOUT
    async getBrowserWithTimeout(timeoutMs: number): Promise<Browser> {
        const availableBrowser = this.pool.find(p => !p.inUse);

        if (availableBrowser) {
            // Ensure browser is prepared before returning
            await this.prepareIfNeeded(availableBrowser);

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

    // Opsi 3: IMMEDIATE
    async getBrowserImmediate(): Promise<Browser | null> {
        const availableBrowser = this.pool.find(p => !p.inUse);

        if (availableBrowser) {
            // Ensure browser is prepared before returning
            await this.prepareIfNeeded(availableBrowser);

            availableBrowser.inUse = true;
            availableBrowser.lastUsedAt = Date.now();
            return availableBrowser.browser;
        }

        return null;
    }

    releaseBrowser(browser: Browser): void {
        const pooledBrowser = this.pool.find(p => p.browser === browser);

        if (!pooledBrowser) {
            console.warn('Tried to release unknown browser');
            return;
        }

        // Jika ada yang menunggu, berikan browser ke mereka
        if (this.waitingQueue.length > 0) {
            const waiter = this.waitingQueue.shift();
            clearTimeout(waiter!.timeout);
            waiter!.resolve(browser);
            console.log(`Browser allocated to waiting request. Queue: ${this.waitingQueue.length}`);
        } else {
            // Jika tidak ada yang menunggu, mark sebagai tidak dipakai
            pooledBrowser.inUse = false;
            pooledBrowser.lastUsedAt = Date.now();
        }
    }

    private processWaitingQueue(): void {
        const now = Date.now();
        const expired = this.waitingQueue.filter(
            w => (now - w.timestamp) > this.maxWaitTime
        );

        expired.forEach(w => {
            clearTimeout(w.timeout);
            w.reject(new Error(`Timeout waiting for browser (${this.maxWaitTime}ms)`));
        });

        this.waitingQueue = this.waitingQueue.filter(
            w => (now - w.timestamp) <= this.maxWaitTime
        );
    }

    getPoolStatus() {
        const inUse = this.pool.filter(p => p.inUse).length;
        const available = this.pool.filter(p => !p.inUse).length;
        const prepared = this.pool.filter(p => p.isPrepared).length;
        const waiting = this.waitingQueue.length;
        const avgWaitTime = this.waitingQueue.length > 0
            ? this.waitingQueue.reduce((sum, w) => sum + (Date.now() - w.timestamp), 0) / this.waitingQueue.length
            : 0;

        return {
            inUse,
            available,
            prepared,
            waiting,
            total: this.pool.length,
            avgWaitTimeMs: Math.round(avgWaitTime),
            utilizationPercent: Math.round((inUse / this.pool.length) * 100),
            isPreparing: this.isPreparing,
            lastPrepareStatus: this.getLastPrepareTime(),
        };
    }

    private getLastPrepareTime(): string {
        const lastPrepare = Math.min(...this.pool.map(p => p.lastPreparedAt));
        if (lastPrepare === 0) return 'Never';

        const timeSince = Date.now() - lastPrepare;
        const minutes = Math.floor(timeSince / 60000);
        const seconds = Math.floor((timeSince % 60000) / 1000);

        return `${minutes}m ${seconds}s ago`;
    }

    // Manual trigger prepare (untuk testing)
    async triggerPrepare(): Promise<{ success: boolean; message: string }> {
        if (this.isPreparing) {
            return { success: false, message: 'Already preparing' };
        }

        await this.prepareAllBrowsers();
        return { success: true, message: 'Prepare triggered successfully' };
    }

    async gotoWithCaptchaSolver(page: Page, url: string) {
        try {
            await page.goto(url, {
                waitUntil: 'networkidle0',
            });
            const gotCaptcha = await page.evaluate(() => {
                // @ts-ignore
                return !!window?.WtmCaptcha;
            });
            if (gotCaptcha) {
                console.log('got captcha, will solve it');
                await page.waitForSelector('#rcpt_img', {
                    visible: true,
                });
                const src = await page.$eval('#rcpt_img', (el: HTMLImageElement) => el.src);
                // get text class="captcha_message"
                const captchaMessage = await page.$eval('.captcha_message', (el: HTMLElement) => el.textContent);
                console.log(src);
                console.log(captchaMessage);
                const answer = await this.captchaSolverService.solveCaptcha(src, captchaMessage || '');
                console.log(answer);
                // id="rcpt_answer"
                await page.type('#rcpt_answer', answer || '');
                // click id="cpt_confirm"
                await page.click('#cpt_confirm');
                // wait for networkidle2
                await page.waitForNavigation({
                    waitUntil: 'networkidle2',
                });
                // screenshot
                await page.screenshot({
                    path: 'screenshot.png',
                    fullPage: true,
                });
            }
        } catch (error) {
            console.log(error);
        }
    }
}