import { Module } from '@nestjs/common';
import { ScraperService } from './scraper.service';
import { ScraperController } from './scraper.controller';
import { BrowserModule } from '../browser/browser.module';
import { CaptchaModule } from '../captcha/captcha.module';

@Module({
    imports: [BrowserModule, CaptchaModule],
    controllers: [ScraperController],
    providers: [ScraperService],
    exports: [ScraperService],
})
export class ScraperModule {}