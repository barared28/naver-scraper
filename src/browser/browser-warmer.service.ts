import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { newInjectedPage } from 'fingerprint-injector';
import { FingerprintGenerator } from 'fingerprint-generator';
import { BrowserPoolService } from './browser-pool.service';
import { CaptchaSolverService } from 'src/captcha/captcha-solver.service';

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
const fingerprint = generator.getFingerprint();

@Injectable()
export class BrowserWarmerService implements OnModuleInit, OnModuleDestroy {
    private warmupInterval: NodeJS.Timeout;
    private isWarming: boolean = false;
    private prepareIntervalTime: number = 5 * 60 * 1000;
    private logger = new Logger(BrowserWarmerService.name);

    constructor(
        private readonly browserPoolService: BrowserPoolService,
        private readonly captchaSolverService: CaptchaSolverService,
    ) {
        this.prepareIntervalTime = parseInt(process.env.PREPARE_INTERVAL || '300000', 10);
    }

    async onModuleInit() {
        this.logger.log(
            `Browser warmer initialized (interval: ${this.prepareIntervalTime}ms = ${this.prepareIntervalTime / 60000} minutes)`,
        );

        // Block until all browsers are connected
        await this.waitForPoolReadyThenPrepare();

        // Periodic prepare browsers every interval
        this.warmupInterval = setInterval(
            () => this.prepareAllBrowsers(),
            this.prepareIntervalTime,
        );
    }

    private async waitForPoolReadyThenPrepare(): Promise<void> {
        // Wait up to 30 seconds for all browsers to connect
        let attempts = 0;
        const maxAttempts = 60; // 30 seconds with 500ms interval

        while (attempts < maxAttempts) {
            const pooledBrowsers = this.browserPoolService.getPooledBrowsers();
            const expectedBrowsers = this.browserPoolService.getExpectedBrowserCount();

            if (pooledBrowsers.length === expectedBrowsers && expectedBrowsers > 0) {
                this.logger.log('All browsers connected, starting warmup...');
                await this.prepareAllBrowsers();
                this.browserPoolService.notifyWarmupComplete();
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

    onModuleDestroy() {
        if (this.warmupInterval) clearInterval(this.warmupInterval);
        this.logger.log('Browser warmer destroyed');
    }

    private async prepareAllBrowsers(): Promise<void> {
        if (this.isWarming) {
            this.logger.log('Already warming up, skipping...');
            return;
        }

        this.isWarming = true;
        this.logger.log(`Starting prepare cycle for all ${this.browserPoolService.getPooledBrowsers().length} browsers...`);

        const results = await Promise.allSettled(
            this.browserPoolService.getPooledBrowsers().map(pb => this.prepareBrowser(pb)),
        );

        const successful = results.filter(r => r.status === 'fulfilled' && r.value).length;
        this.logger.log(
            `Prepare cycle complete: ${successful}/${this.browserPoolService.getPooledBrowsers().length} browsers prepared`,
        );

        this.isWarming = false;
    }

    private async prepareBrowser(pooledBrowser: any): Promise<boolean> {
        try {
            this.logger.log('Preparing browser...');

            const oldPages = await pooledBrowser.browser.pages();

            const page = await newInjectedPage(pooledBrowser.browser, {
                fingerprint,
            });

            // set viewport
            await page.setViewport({
                width: 1920,
                height: 1080,
            });

            await Promise.all(oldPages.map(p => p.close().catch(() => {})));

            const [ip, port, username, password] = pooledBrowser.proxy.split(':');

            // authenticate with proxy
            await page.authenticate({
                username,
                password,
            });

            const listenRequest = (req: any) => {
                const type = req.resourceType();
                // ignore image & style request
                if (type === 'image' || type === 'stylesheet') {
                    req.abort().catch(() => {});
                } else {
                    req.continue().catch(() => {});
                }
            };

            await page.setRequestInterception(true);
            page.on('request', listenRequest);

            // check ip
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

            // screenshot
            await page.screenshot({
                path: `naver-${new Date().toISOString().replace(/:/g, '-')}.png`,
                fullPage: true,
            });

            // cleanup
            await page.setRequestInterception(false).catch(() => {});
            // page.removeAllListeners();

            this.browserPoolService.updateBrowserPrepared(pooledBrowser.browser, true);

            this.logger.log(`Browser prepared successfully`);
            return true;
        } catch (error) {
            this.logger.error(`Failed to prepare browser:`, error.message);
            this.browserPoolService.updateBrowserPrepared(pooledBrowser.browser, false);
            return false;
        }
    }

    // Manual trigger prepare (for testing)
    async triggerPrepare(): Promise<{ success: boolean; message: string }> {
        if (this.isWarming) {
            return { success: false, message: 'Already preparing' };
        }

        await this.prepareAllBrowsers();
        return { success: true, message: 'Prepare triggered successfully' };
    }

    getPoolStatus() {
        return this.browserPoolService.isPoolHealthy();
    }
}