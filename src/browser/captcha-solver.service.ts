import { Injectable } from '@nestjs/common';
import Anthropic from "@anthropic-ai/sdk";
import * as puppeteer from 'puppeteer';

@Injectable()
export class CaptchaSolverService {
    private client: Anthropic;
    private ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

    constructor() {
        this.client = new Anthropic({
            apiKey: this.ANTHROPIC_API_KEY,
        });
    }

    async solveCaptcha(dataURI: string, question: string) {
        const message = await this.client.messages.create({
            model: "claude-sonnet-4-5",
            max_tokens: 1024,
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "image",
                            source: {
                                type: "base64",
                                media_type: "image/jpeg",
                                data: dataURI?.split(',')[1],
                            },
                        },
                        {
                            type: "text",
                            text: `${question}`,
                        },
                    ],
                },
            ],
            system: "Answer ONLY with the direct answer. No explanation, no preamble, no additional text.",
        });

        return message.content[0].type === 'text' && message.content[0].text;
    }

    async gotoWithCaptchaSolver(page: puppeteer.Page, url: string, waitUntil: puppeteer.PuppeteerLifeCycleEvent = 'domcontentloaded') {
        try {
            await page.goto(url, {
                waitUntil,
            });
            let gotCaptcha = await page.evaluate(() => {
                // @ts-ignore
                return !!window?.WtmCaptcha;
            });
            while (gotCaptcha) {
                console.log('got captcha, will solve it');
                await page.waitForSelector('#rcpt_img', {
                    visible: true,
                });
                const src = await page.$eval('#rcpt_img', (el: HTMLImageElement) => el.src);
                // get text class="captcha_message"
                const captchaMessage = await page.$eval('.captcha_message', (el: HTMLElement) => el.textContent);
                console.log(captchaMessage);
                const answer = await this.solveCaptcha(src, captchaMessage || '');
                console.log(answer);
                // id="rcpt_answer"
                await page.type('#rcpt_answer', answer || '');
                // click id="cpt_confirm"
                await page.click('#cpt_confirm');
                // wait for networkidle2
                await page.waitForNavigation({
                    waitUntil: 'domcontentloaded',
                    timeout: 20 * 1000,
                })?.catch(() => {
                    console.log('navigation failed');
                });
                gotCaptcha = await page.evaluate(() => {
                    // @ts-ignore
                    return !!window?.WtmCaptcha;
                });
                if (!gotCaptcha) {
                    // screenshot
                    await page.screenshot({
                        path: 'screenshot.png',
                        fullPage: true,
                    });
                    break;
                }
                console.log('got captcha, will try again');
            }
        } catch (error) {
            console.log(error);
        }
    }
}