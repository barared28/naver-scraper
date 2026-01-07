import { Injectable, Logger } from '@nestjs/common';
import * as puppeteer from 'puppeteer';
import { BrowserPoolService } from '../browser/browser-pool.service';
import { CaptchaSolverService } from '../captcha/captcha-solver.service';

@Injectable()
export class ScraperService {
    private readonly logger = new Logger(ScraperService.name);

    private PRODUCT_URL_REGEX = /v2\/channels\/[^/]+\/products\/\d+\?withWindow=false/;
    private BENEFIT_URL_REGEX = /v2\/channels\/[^/]+\/benefits\/by-products\/\d+\?categoryId=\d+/;

    constructor(
        private readonly browserPoolService: BrowserPoolService,
        private readonly captchaSolverService: CaptchaSolverService,
    ) { }

    async scrape(url: string): Promise<any> {
        let browser: puppeteer.Browser | null = null;

        try {
            // Get browser from pool
            browser = await this.browserPoolService.getBrowser();
            const pages = await browser.pages();

            if (pages.length === 0) {
                throw new Error('Browser has no pages');
            }

            const currentPage = pages[0];
            let response: Record<string, any> | null = null;
            let benefitResponse: Record<string, any> | null = null;

            // Setup request interception handler
            const listenRequest = (req: puppeteer.HTTPRequest) => {
                const type = req.resourceType();

                // ignore image & style request
                if (type === 'image' || type === 'stylesheet') {
                    req.abort().catch(() => { });
                } else {
                    req.continue().catch(() => { });
                }
            };

            // Setup response handler
            const listenResponse = async (res: puppeteer.HTTPResponse) => {
                const resUrl = res.url();

                if (!this.PRODUCT_URL_REGEX.test(resUrl) && !this.BENEFIT_URL_REGEX.test(resUrl)) {
                    return;
                }

                try {
                    const status = res.status();
                    this.logger.log(`Response: ${resUrl} (${status})`);

                    const isSuccess = status === 200;
                    const data = isSuccess ? await res.json() : status;

                    if (this.PRODUCT_URL_REGEX.test(resUrl)) {
                        response = data;
                    } else if (this.BENEFIT_URL_REGEX.test(resUrl)) {
                        benefitResponse = data;
                    }
                } catch (err) {
                    this.logger.error('Parse error:', err.message);
                }
            };

            // Setup request interception
            await currentPage.setRequestInterception(true);
            currentPage.on('request', listenRequest);
            currentPage.on('response', listenResponse);

            this.logger.log(`Starting scrape of ${url}`);

            // Navigate to URL with captcha solver
            await this.captchaSolverService.gotoWithCaptchaSolver(
                currentPage,
                url,
                'domcontentloaded',
            );

            // Wait up to 90 seconds for both responses
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Timeout waiting for responses'));
                }, 90000);

                const checkInterval = setInterval(() => {
                    if (response !== null && benefitResponse !== null) {
                        clearTimeout(timeout);
                        clearInterval(checkInterval);
                        resolve();
                    }
                }, 500);
            });

            this.logger.log('Scrape completed successfully');

            return {
                product: response,
                benefit: benefitResponse,
            };
        } catch (error) {
            this.logger.error('Scrape error:', error.message);
            throw error;
        } finally {
            // Cleanup
            if (browser) {
                this.browserPoolService.cleanup(browser);
            }
        }
    }


    async scrapeProducts(keyword: string) {
        let browser: puppeteer.Browser | null = null;
        const url = `https://search.shopping.naver.com/ns/search?query=${keyword}&queryType=ac`
        try {
            // Get browser from pool
            browser = await this.browserPoolService.getBrowser();
            const pages = await browser.pages();

            if (pages.length === 0) {
                throw new Error('Browser has no pages');
            }

            const currentPage = pages[0];

            // Setup request interception handler
            const listenRequest = (req: puppeteer.HTTPRequest) => {
                const type = req.resourceType();

                // ignore image & style request
                if (type === 'image' || type === 'stylesheet') {
                    req.abort().catch(() => { });
                } else {
                    req.continue().catch(() => { });
                }
            };

            // Setup request interception
            await currentPage.setRequestInterception(true);
            currentPage.on('request', listenRequest);

            await this.captchaSolverService.gotoWithCaptchaSolver(
                currentPage,
                url,
                'networkidle2',
            );

            await currentPage.waitForSelector('a[href*="smartstore.naver.com"][href*="/products/"]')?.catch(() => {});

            const productUrls = await currentPage
                .$$eval('a[href*="smartstore.naver.com"][href*="/products/"]', (links: any) => {
                    return links.map((link: any) => link.href?.split('?')[0] || '');
                })
                .catch(() => []);

            this.logger.log(`Found ${productUrls.length} product URLs`);

            return productUrls || [];
        } catch (error) {
            this.logger.error('ScrapeProducts error:', error.message);
            throw error;
        } finally {
            // Cleanup
            if (browser) {
                this.browserPoolService.cleanup(browser);
            }
        }
    }
}