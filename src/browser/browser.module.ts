import { Module } from '@nestjs/common';
import { BrowserPoolService } from './browser-pool.service';
import { BrowserWarmerService } from './browser-warmer.service';
import { CaptchaModule } from '../captcha/captcha.module';

@Module({
    imports: [CaptchaModule],
    providers: [BrowserPoolService, BrowserWarmerService],
    exports: [BrowserPoolService, BrowserWarmerService],
})
export class BrowserModule {}