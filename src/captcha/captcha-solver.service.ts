import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import * as puppeteer from 'puppeteer';

@Injectable()
export class CaptchaSolverService {
    private client: Anthropic;
    private ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
    private logger = new Logger(CaptchaSolverService.name);

    constructor() {
        this.client = new Anthropic({
            apiKey: this.ANTHROPIC_API_KEY,
        });
    }

    async solveCaptcha(dataURI: string, question: string): Promise<string> {
        try {
            const message = await this.client.messages.create({
                model: 'claude-sonnet-4-5',
                max_tokens: 1024,
                messages: [
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'image',
                                source: {
                                    type: 'base64',
                                    media_type: 'image/jpeg',
                                    data: dataURI?.split(',')[1],
                                },
                            },
                            {
                                type: 'text',
                                text: `${question}`,
                            },
                        ],
                    },
                ],
                system: 'Answer ONLY with the direct answer. No explanation, no preamble, no additional text.',
            });

            const textContent = message.content.find(c => c.type === 'text');
            return textContent && textContent.type === 'text' ? textContent.text : '';
        } catch (error) {
            this.logger.error('Failed to solve captcha:', error.message);
            throw error;
        }
    }

    async gotoWithCaptchaSolver(
        page: puppeteer.Page,
        url: string,
        waitUntil: puppeteer.PuppeteerLifeCycleEvent = 'domcontentloaded',
    ): Promise<void> {
        try {
            await page.goto(url, {
                waitUntil,
            });

            let gotCaptcha = await page.evaluate(() => {
                // @ts-ignore
                return !!window?.WtmCaptcha;
            });

            while (gotCaptcha) {
                this.logger.log('Captcha detected, attempting to solve...');

                try {
                    await page.waitForSelector('#rcpt_img', {
                        visible: true,
                        timeout: 10000,
                    });

                    const src = await page.$eval('#rcpt_img', (el: HTMLImageElement) => el.src);

                    const captchaMessage = await page.$eval(
                        '.captcha_message',
                        (el: HTMLElement) => el.textContent,
                    );

                    this.logger.log(`Question: ${captchaMessage}`);

                    const answer = await this.solveCaptcha(src, captchaMessage || '');
                    this.logger.log(`Answer: ${answer}`);

                    await page.type('#rcpt_answer', answer || '');
                    await page.click('#cpt_confirm');

                    // Wait for navigation or timeout
                    await page
                        .waitForNavigation({
                            waitUntil: 'domcontentloaded',
                            timeout: 20 * 1000,
                        })
                        .catch(() => {
                            this.logger.log('Navigation timeout, continuing...');
                        });

                    // Check if captcha is still present
                    gotCaptcha = await page.evaluate(() => {
                        // @ts-ignore
                        return !!window?.WtmCaptcha;
                    });

                    if (!gotCaptcha) {
                        this.logger.log('Captcha solved successfully');
                        break;
                    }

                    this.logger.log('Captcha still present, retrying...');
                } catch (innerError) {
                    this.logger.error('Error during captcha solving:', innerError.message);
                    gotCaptcha = false;
                }
            }
        } catch (error) {
            this.logger.error('Error in gotoWithCaptchaSolver:', error.message);
            // Don't throw, just log and continue
        }
    }
}