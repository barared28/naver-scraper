import { Module } from '@nestjs/common';
import { BrowserService } from './browser.service';
import { CaptchaSolverService } from './captcha-solver.service';
import { BrowserPoolService } from './browser-pool.service';

@Module({
    providers: [BrowserService, CaptchaSolverService, BrowserPoolService],
    exports: [BrowserService, CaptchaSolverService, BrowserPoolService],
})
export class BrowserModule {}
