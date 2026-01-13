import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { newInjectedPage } from 'fingerprint-injector';
import { FingerprintGenerator } from 'fingerprint-generator';
import { BrowserPoolService } from './browser-pool.service';
import { CaptchaSolverService } from '../captcha/captcha-solver.service';

const koreanSearchKeywords = [
    '아이폰', // iPhone
    '유니클로', // Uniqlo
    '나이키', // Nike
    '아디다스', // Adidas
    '루이비통', // Louis Vuitton
    '구찌', // Gucci
    '삼성', // Samsung
    'LG', // LG
    '다이슨', // Dyson
    '스타벅스', // Starbucks
    '네스프레소', // Nespresso
    '다이어리', // Diary
    '향수', // Perfume
    '립스틱', // Lipstick
    '마스크', // Mask
    '선크림', // Sunscreen
    '비타민', // Vitamin
    '헤드폰', // Headphone
    '스피커', // Speaker
    '휴대폰케이스', // Phone Case
];

function getRandomKeyword(): string {
    const randomIndex = Math.floor(Math.random() * koreanSearchKeywords.length);
    return koreanSearchKeywords[randomIndex];
}

const generator = new FingerprintGenerator({
    devices: ['desktop'],
    operatingSystems: ['macos'],
    browsers: ['chrome'],
    locales: ['ko-KR'],
    screen: {
        maxHeight: 1080,
        maxWidth: 1920,
        minHeight: 1080,
        minWidth: 1920,
    },
    httpVersion: '2',
});

@Injectable()
export class BrowserWarmerService implements OnModuleInit, OnModuleDestroy {
    private warmupInterval: NodeJS.Timeout;
    private warmupQueue: any[] = [];
    private isWarmingAny: boolean = false;
    private prepareIntervalTime: number = 5 * 60 * 1000;
    private idleThreshold: number = 2 * 60 * 1000;
    private logger = new Logger(BrowserWarmerService.name);

    constructor(
        private readonly browserPoolService: BrowserPoolService,
        private readonly captchaSolverService: CaptchaSolverService,
    ) {
        this.prepareIntervalTime = parseInt(process.env.PREPARE_INTERVAL || '300000', 10);
        this.idleThreshold = parseInt(process.env.IDLE_THRESHOLD || '120000', 10);
    }

    async onModuleInit() {
        this.logger.log(
            `Browser warmer initialized (interval: ${this.prepareIntervalTime}ms = ${this.prepareIntervalTime / 60000} minutes, idle threshold: ${this.idleThreshold}ms = ${this.idleThreshold / 1000} seconds)`,
        );

        // Block until all browsers are connected AND initial warming complete
        await this.waitForPoolReadyThenPrepare();

        // Periodic warming scheduling every interval
        this.warmupInterval = setInterval(
            () => this.scheduleIdleBrowsersForWarming(),
            this.prepareIntervalTime,
        );
    }

    private async waitForPoolReadyThenPrepare(): Promise<void> {
        let attempts = 0;
        const maxAttempts = 60; // 30 seconds with 500ms interval

        while (attempts < maxAttempts) {
            const pooledBrowsers = this.browserPoolService.getPooledBrowsers();
            const expectedBrowsers = this.browserPoolService.getExpectedBrowserCount();

            if (pooledBrowsers.length === expectedBrowsers && expectedBrowsers > 0) {
                this.logger.log('All browsers connected, starting initial warmup...');
                
                // For initial warmup, warm all browsers regardless of idle state
                await this.scheduleAllBrowsersForInitialWarming();
                
                // Wait for all browsers to complete initial warming
                await this.waitForInitialWarmupComplete();
                
                this.browserPoolService.notifyWarmupComplete();
                this.logger.log('✓ All browsers warmed up, application ready to start');
                return;
            }

            this.logger.log(
                `Waiting for browsers to connect... (${pooledBrowsers.length}/${expectedBrowsers})`,
            );
            await new Promise(resolve => setTimeout(resolve, 500));
            attempts++;
        }

        this.logger.error('Timeout waiting for browsers to connect');
    }

    /**
     * Block/wait until all browsers complete initial warming
     */
    private async waitForInitialWarmupComplete(): Promise<void> {
        const maxWaitTime = 5 * 60 * 1000; // 5 minutes timeout
        const startTime = Date.now();

        while (true) {
            const elapsed = Date.now() - startTime;
            
            if (elapsed > maxWaitTime) {
                this.logger.error('Timeout waiting for initial warming to complete');
                return;
            }

            // If nothing is warming and queue is empty, warming is done
            if (!this.isWarmingAny && this.warmupQueue.length === 0) {
                this.logger.log('Initial warming complete');
                return;
            }

            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    onModuleDestroy() {
        if (this.warmupInterval) clearInterval(this.warmupInterval);
        this.logger.log('Browser warmer destroyed');
    }

    /**
     * Schedule all browsers for initial warming (startup phase)
     * All browsers are warmed regardless of idle state
     */
    private async scheduleAllBrowsersForInitialWarming(): Promise<void> {
        const pooledBrowsers = this.browserPoolService.getPooledBrowsers();
        
        this.warmupQueue = [...pooledBrowsers];
        
        this.logger.log(`Scheduled ${this.warmupQueue.length} browsers for initial warming (sequential)`);

        // Start processing queue (fire and forget)
        this.processWarmingQueue(true);
    }

    /**
     * Schedule only idle browsers for warming (periodic check)
     * Only warms browsers that haven't been used for idle threshold
     */
    private async scheduleIdleBrowsersForWarming(): Promise<void> {
        const pooledBrowsers = this.browserPoolService.getPooledBrowsers();
        
        // Filter: only browsers that are idle beyond threshold and not currently in use
        const idleBrowsers = pooledBrowsers.filter(pb => {
            const idleTime = Date.now() - (pb.lastUsedAt || 0);
            const isIdle = idleTime > this.idleThreshold;
            
            if (isIdle && !pb.inUse) {
                this.logger.log(`Browser is idle for ${Math.floor(idleTime / 1000)}s (threshold: ${Math.floor(this.idleThreshold / 1000)}s), scheduled for warming`);
                return true;
            }
            
            return false;
        });

        if (idleBrowsers.length === 0) {
            this.logger.log('No idle browsers to warm');
            return;
        }

        this.warmupQueue = [...idleBrowsers];
        
        this.logger.log(`Scheduled ${this.warmupQueue.length} idle browsers for warming (sequential)`);

        // Start processing queue
        this.processWarmingQueue();
    }

    /**
     * Process warming queue sequentially (one at a time)
     */
    private async processWarmingQueue(isInitialWarmup: boolean = false): Promise<void> {
        // Skip if warming is already in progress
        if (this.isWarmingAny) {
            this.logger.log('Warming already in progress, queue will be processed after completion');
            return;
        }

        while (this.warmupQueue.length > 0) {
            const pooledBrowser = this.warmupQueue.shift();

            // Check if browser is currently in use
            if (pooledBrowser.inUse) {
                this.logger.log(`Browser is in use, waiting before warming...`);
                // Queue back for retry later
                this.warmupQueue.push(pooledBrowser);
                await new Promise(resolve => setTimeout(resolve, 500));
                continue;
            }

            if (!isInitialWarmup) {
                this.logger.log(`Browser ${pooledBrowser.proxy} is not initial warming, destroying and recreating`);
                // destroy browser
                await this.browserPoolService.destroyBrowser(pooledBrowser.browser);
                // wait 2 seconds
                await new Promise(resolve => setTimeout(resolve, 2000));
                // create new browser
                const browser = await this.browserPoolService.launchBrowser(pooledBrowser.proxy);
                if (!browser) continue;
                pooledBrowser.browser = browser;
            }

            // Warm single browser (sequential)
            await this.prepareBrowser(pooledBrowser);

            // Small delay before warming next browser
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        this.logger.log('All browsers warming queue processed');
    }

    private async prepareBrowser(pooledBrowser: any): Promise<boolean> {
        // Double check browser is not in use
        if (pooledBrowser.inUse) {
            this.logger.log('Browser is in use, skipping warming');
            return false;
        }

        this.isWarmingAny = true;

        try {
            this.logger.log('Preparing browser...');

            const oldPages = await pooledBrowser.browser.pages();

            const page = await newInjectedPage(pooledBrowser.browser, {
                fingerprint: generator.getFingerprint(),
            });

            // Set viewport
            await page.setViewport({
                width: 1920,
                height: 1080,
            });

            await Promise.all(oldPages.map(p => p.close().catch(() => {})));

            const [ip, port, username, password] = pooledBrowser.proxy.split(':');

            // Authenticate with proxy
            await page.authenticate({
                username,
                password,
            });

            const listenRequest = (req: any) => {
                const type = req.resourceType();
                // Ignore image & style requests
                if (type === 'image' || type === 'stylesheet') {
                    req.abort().catch(() => {});
                } else {
                    req.continue().catch(() => {});
                }
            };

            await page.setRequestInterception(true);
            page.on('request', listenRequest);

            // Check IP
            const ipResult = await page.evaluate(() =>
                fetch('https://api64.ipify.org?format=json').then(res => res.json()),
            );
            this.logger.log(`Check IP: ${ipResult.ip}`);

            this.logger.log(`Navigating to https://google.com...`);
            await this.captchaSolverService.gotoWithCaptchaSolver(page, 'https://google.com');

            this.logger.log(`Navigating to https://naver.com...`);
            await this.captchaSolverService.gotoWithCaptchaSolver(page, 'https://naver.com');

            this.logger.log(`Navigating to https://shopping.naver.com/ns/home...`);
            await this.captchaSolverService.gotoWithCaptchaSolver(
                page,
                'https://shopping.naver.com/ns/home',
            );

            const randomKeyword = getRandomKeyword();
            this.logger.log(
                `Navigating to https://search.shopping.naver.com/ns/search?query=${randomKeyword}&queryType=ac`,
            );
            await this.captchaSolverService.gotoWithCaptchaSolver(
                page,
                `https://search.shopping.naver.com/ns/search?query=${randomKeyword}&queryType=ac`,
                'networkidle2',
            );

            const productUrls = await page
                .$$eval('a[href*="smartstore.naver.com"][href*="/products/"]', (links: any) => {
                    return links.map((link: any) => link.href);
                })
                .catch(() => []);

            this.logger.log(`Found ${productUrls.length} product URLs`);

            if (productUrls.length > 0) {
                const randomUrl = productUrls[Math.floor(Math.random() * productUrls.length)];
                this.logger.log(`Random product URL: ${randomUrl}`);

                await this.captchaSolverService.gotoWithCaptchaSolver(page, randomUrl, 'networkidle2');

                const finalUrl = page.url();
                this.logger.log(`Final URL: ${finalUrl}`);
            }

            // Cleanup
            await page.setRequestInterception(false).catch(() => {});

            this.browserPoolService.updateBrowserPrepared(pooledBrowser.browser, true);
            
            // Update lastUsedAt to reset idle timer after successful warming
            pooledBrowser.lastUsedAt = Date.now();

            this.logger.log(`Browser prepared successfully`);
            return true;
        } catch (error) {
            this.logger.error(`Failed to prepare browser:`, error.message);
            this.browserPoolService.updateBrowserPrepared(pooledBrowser.browser, false);
            return false;
        } finally {
            this.isWarmingAny = false;
            // Continue processing queue if there are items
            this.processWarmingQueue();
        }
    }

    // Manual trigger warming for testing
    async triggerWarming(): Promise<{ success: boolean; message: string }> {
        if (this.isWarmingAny) {
            return { success: false, message: 'Already warming a browser' };
        }

        await this.scheduleIdleBrowsersForWarming();
        return { success: true, message: 'Idle browsers scheduled for warming' };
    }

    getPoolStatus() {
        return this.browserPoolService.isPoolHealthy();
    }

    /**
     * Get current warming queue status (for monitoring)
     */
    getWarmingQueueStatus() {
        return {
            queueSize: this.warmupQueue.length,
            isWarmingAny: this.isWarmingAny,
            idleThreshold: this.idleThreshold,
            queueBrowsers: this.warmupQueue.map((pb, i) => ({
                index: i,
                inUse: pb.inUse,
                idleTime: Date.now() - (pb.lastUsedAt || 0),
            })),
        };
    }
}