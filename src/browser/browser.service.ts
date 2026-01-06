import { Injectable } from '@nestjs/common';
import * as puppeteer from 'puppeteer';
import { CaptchaSolverService } from './captcha-solver.service';
import { BrowserPoolService } from './browser-pool.service';

@Injectable()
export class BrowserService {
    constructor(private readonly captchaSolverService: CaptchaSolverService, private readonly browserPoolService: BrowserPoolService) { }

    async scrape(url: string) {
        const browser = await this.browserPoolService.getBrowser();
        const pages = await browser.pages();
        if (pages.length === 0) {
            throw new Error('Browser has no pages');
        }
        const PRODUCT_URL_REGEX = /v2\/channels\/[^/]+\/products\/\d+\?withWindow=false/;
        const BENEFIT_URL_REGEX = /v2\/channels\/[^/]+\/benefits\/by-products\/\d+\?categoryId=\d+/;
        const PRODUCT_BENEFITS_URL_REGEX = /v2\/channels\/[^/]+\/product-benefits\/\d+/;
        let response: Record<string, any> | null = null;
        let benefitResponse: Record<string, any> | null = null;
        const page = pages[0];

        const listenRequest = (req) => {
            // req.continue();
            // return
            // const url = req.url();
            const type = req.resourceType();

            // ignore image & style request
            if (type === 'image' || type === 'stylesheet') {
                req.abort();
            } else {
                console.log(url, type);
                req.continue();
            }

            // if (!PRODUCT_URL_REGEX.test(url) && !BENEFIT_URL_REGEX.test(url) && !PRODUCT_BENEFITS_URL_REGEX.test(url) && type !== 'document' && type !== 'script' && !url.includes('wcpt')) {
            //     req.abort();
            // } else {
            //     req.continue();
            // }
        }
        const listenResponse: puppeteer.Handler<puppeteer.HTTPResponse> = async (res) => {
            const url = res.url();

            if (!PRODUCT_URL_REGEX.test(url) && !BENEFIT_URL_REGEX.test(url)) return;

            try {
                const status = res.status();
                console.log(url, status);
                const isSuccess = status === 200;
                const data = isSuccess ? await res.json() : status;
                if (PRODUCT_URL_REGEX.test(url)) {
                    response = data;
                } else if (BENEFIT_URL_REGEX.test(url)) {
                    benefitResponse = data;
                }
            } catch (err) {
                console.error('Parse error:', err);
            }
        }
        try {
            await page.setRequestInterception(true);
            page.on('request', listenRequest);
            page.on('response', listenResponse);
            this.captchaSolverService.gotoWithCaptchaSolver(page, url, 'domcontentloaded');
            await new Promise((resolve, reject) => {
                // timeout is 90 seconds
                const timeout = setTimeout(() => {
                    reject(new Error('Timeout waiting for responses'));
                }, 90000);
                // check every 1 second
                const checkInterval = setInterval(() => {
                    if (response !== null && benefitResponse !== null) {
                        clearTimeout(timeout);
                        clearInterval(checkInterval);
                        resolve(null);
                    }
                }, 500);
            })
        } catch (error) {
            console.log(error);
        } finally {
            // await page.screenshot({
            //     path: `naver-${new Date().toISOString().replace(/:/g, '-')}.png`,
            //     fullPage: true,
            // })
            page.off('request', listenRequest);
            page.off('response', listenResponse);
            this.browserPoolService.releaseBrowser(browser);
        }
        return {
            product: response,
            benefit: benefitResponse,
        };
    }
}
