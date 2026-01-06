import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { ScraperModule } from './scraper/scraper.module';
import { BrowserService } from './browser/browser.service';
import { CaptchaSolverService } from './browser/captcha-solver.service';
import { BrowserPoolService } from './browser/browser-pool.service';
import { ConfigModule } from '@nestjs/config';
import { BrowserModule } from './browser/browser.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: '.env',
      isGlobal: true,
    }),
    ScraperModule,
    BrowserModule],
  controllers: [AppController],
})
export class AppModule { }
