import { Controller, Get, Query, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ScraperService } from './scraper.service';

@Controller('naver')
export class ScraperController {
    private readonly logger = new Logger(ScraperController.name);
    constructor(private readonly scraperService: ScraperService) {}

    @Get('')
    async scrape(@Query('productUrl') url: string) {
        // Validate URL
        if (!url) {
            throw new HttpException(
                { error: 'URL parameter is required' },
                HttpStatus.BAD_REQUEST,
            );
        }

        try {
            const result = await this.scraperService.scrape(url);
            return {
                success: true,
                data: result,
            };
        } catch (error) {
            this.logger.error('Scraper error:', error.message);
            throw new HttpException(
                { error: error.message || 'Internal server error' },
                HttpStatus.INTERNAL_SERVER_ERROR,
            );
        }
    }

    @Get('search')
    async search(@Query('keyword') keyword: string) {
        // Validate keyword
        if (!keyword) {
            throw new HttpException(
                { error: 'Keyword parameter is required' },
                HttpStatus.BAD_REQUEST,
            );
        }

        try {
            const result = await this.scraperService.scrapeProducts(keyword);
            return {
                success: true,
                data: result,
            };
        } catch (error) {
            this.logger.error('Scraper error:', error.message);
            throw new HttpException(
                { error: error.message || 'Internal server error' },
                HttpStatus.INTERNAL_SERVER_ERROR,
            );
        }
    }
}