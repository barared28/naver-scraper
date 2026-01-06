import { Injectable } from '@nestjs/common';
import { BrowserService } from 'src/browser/browser.service';

@Injectable()
export class ScraperService {
    constructor(private readonly browserService: BrowserService) {}

    async scrape(url: string) {
        return this.browserService.scrape(url);
    }
}
