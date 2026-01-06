import { Module } from '@nestjs/common';
import { ScraperService } from './scraper.service';
import { ScraperController } from './scraper.controller';
import { BrowserModule } from 'src/browser/browser.module';

@Module({
  providers: [ScraperService],
  controllers: [ScraperController],
  imports: [BrowserModule],
})
export class ScraperModule {}
