import { Injectable, OnModuleDestroy, OnModuleInit, Scope } from '@nestjs/common';
import * as puppeteer from 'puppeteer';
import { newInjectedPage } from 'fingerprint-injector';
import { CaptchaSolverService } from './captcha-solver.service';
import { FingerprintGenerator } from 'fingerprint-generator';
import { BrowserPoolService } from './browser-pool.service';

const generator = new FingerprintGenerator({
    devices: ['desktop'],
    operatingSystems: ['windows', 'macos', 'linux'],
    browsers: ['chrome'],
    // locales: ['ko-KR'],
    screen: {
        maxHeight: 1080,
        maxWidth: 1920,
        minHeight: 1080,
        minWidth: 1920,
    }
});
const fingerprint = generator.getFingerprint();

const proxyUrl = `https://brd-customer-hl_3d2f170f-zone-residential_proxy1-country-kr:o36ndicif3ss@brd.superproxy.io:33335`;

@Injectable()
export class BrowserService {
    private browser: puppeteer.Browser;
    private proxyUrl = 'brd.superproxy.io:33335';
    private proxyUsername = 'brd-customer-hl_3d2f170f-zone-residential_proxy1-country-kr';
    private proxyPassword = 'o36ndicif3ss';
    private BROWSERLESS_TOKEN = 'opoaeoleh'
    private BROWSERLESS_URL = process.env.BROWSERLESS_URL || 'localhost:3000';

    constructor(private readonly captchaSolverService: CaptchaSolverService, private readonly browserPoolService: BrowserPoolService) { }

    async init() {
        try {
            const launchArgs = {
                headless: false,
                args: [`--user-data-dir=~/u/naver`],
                // defaultViewport: {
                //     width: 1920,
                //     height: 1080,
                // },
                defaultViewport: null,
            };
            const queryParams = new URLSearchParams({
                token: this.BROWSERLESS_TOKEN,
                timeout: "6000000",
                launch: JSON.stringify(launchArgs)
            }).toString();
            const browserWSEndpoint = `ws://${this.BROWSERLESS_URL}?${queryParams}`;
            this.browser = await puppeteer.connect({
                browserWSEndpoint,
                // defaultViewport: {
                //     width: 1920,
                //     height: 1080,
                // },
                defaultViewport: null,
            });
        } catch (error) {
            // if (tryCount < 3) {
            //     await this.init(domain, tryCount + 1);
            // } else {
            //     throw error;
            // }
        }
    }

    async launch() {
        this.browser = await puppeteer.launch({
            headless: false,
            // proxy 6n8xhsmh.as.thordata.net:9999:td-customer-mrscraperTrial-country-kr:P3nNRQ8C2
            // args: [`--proxy-server=${this.proxyUrl}`],
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                // `--proxy-server=${proxyUrl}`,
                '--ignore-certificate-errors', // Skip SSL verification
                '--disable-web-resources',
                '--disable-web-security'
            ],
            defaultViewport: null,
        });
    }

    async createNewPage() {
        // await this.launch();
        await this.init();
        const oldPages = await this.browser.pages();
        const page = await newInjectedPage(this.browser, {
            fingerprint,
        });
        // set viewport
        await page.setViewport({
            width: 1920,
            height: 1080,
        });
        // const page = await this.browser.newPage();
        // auth 
        // await page.authenticate({
        //     username: this.proxyUsername,
        //     password: this.proxyPassword,
        // });
        // disable all image loading and request other resources
        for (const oldPage of oldPages) {
            await oldPage?.close()?.catch(() => null);
        }
        return page;
    }

    async gotoWithCaptchaSolver(page: puppeteer.Page, url: string) {
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
            const url = req.url();
            const type = req.resourceType();

            if (!PRODUCT_URL_REGEX.test(url) && !BENEFIT_URL_REGEX.test(url) && !PRODUCT_BENEFITS_URL_REGEX.test(url) && type !== 'document' && type !== 'script' && !url.includes('wcpt')) {
                req.abort();
            } else {
                req.continue();
            }
        }
        const listenResponse: puppeteer.Handler<puppeteer.HTTPResponse> = async (res) => {
            const url = res.url();
            
            if (!PRODUCT_URL_REGEX.test(url) && !BENEFIT_URL_REGEX.test(url)) return;

            try {
                const status = res.status();
                console.log(url, status);
                if (status !== 200) {
                    return status;
                }
                const data = await res.json();
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
            await this.gotoWithCaptchaSolver(page, url);
            // await this.browser.close();
            // screenshot
            // console.log('screenshot 1')
            // await page.screenshot({
            //     path: `naver-${new Date().toISOString().replace(/:/g, '-')}.png`,
            //     fullPage: true,
            // })
        } catch (error) {
            console.log(error);
        } finally {
            await page.screenshot({
                path: `naver-${new Date().toISOString().replace(/:/g, '-')}.png`,
                fullPage: true,
            })
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
