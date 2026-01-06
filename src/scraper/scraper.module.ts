import { Module } from '@nestjs/common';
import { ScraperService } from './scraper.service';
import { ScraperController } from './scraper.controller';
import { BrowserModule } from 'src/browser/browser.module';
import { CaptchaModule } from 'src/captcha/captcha.module';

@Module({
    imports: [BrowserModule, CaptchaModule],
    controllers: [ScraperController],
    providers: [ScraperService],
    exports: [ScraperService],
})
export class ScraperModule {}