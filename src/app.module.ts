import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { ScraperModule } from './scraper/scraper.module';
import { ConfigModule } from '@nestjs/config';
import { BrowserModule } from './browser/browser.module';
import { CaptchaModule } from './captcha/captcha.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: '.env',
      isGlobal: true,
    }),
    ScraperModule,
    BrowserModule,
    CaptchaModule
  ],
  controllers: [AppController],
})
export class AppModule { }
