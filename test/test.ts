import path from "path";
import fs from "fs";
import axios from "axios";
import env from "dotenv";
import keywordJson from './keyword.json';

env.config();

const PORT = process.env.PORT ?? 3000;

// ============== CONFIGURATION ==============
const CONFIG = {
    FOLDER_RESULT: path.join(__dirname, 'result'),
    KEYWORDS: keywordJson.keywords,
    MAX_RESULT: 1000,
    BATCH_SIZE: 3,  // Number of concurrent requests
    SEARCH_API_URL: `http://localhost:${PORT}/naver/search`,
    PRODUCT_API_URL: `http://localhost:${PORT}/naver/`,
};

// ============== SETUP ==============
if (!fs.existsSync(CONFIG.FOLDER_RESULT)) {
    fs.mkdirSync(CONFIG.FOLDER_RESULT, { recursive: true });
}

class Logger {
    log(msg: string, data?: any) {
        console.log(`[${new Date().toLocaleTimeString()}] ${msg}`, data || '');
    }

    error(msg: string, err?: any) {
        console.error(`[${new Date().toLocaleTimeString()}] ❌ ${msg}`, err?.message || err || '');
    }

    success(msg: string, data?: any) {
        console.log(`[${new Date().toLocaleTimeString()}] ✅ ${msg}`, data || '');
    }
}

const logger = new Logger();

// ============== BATCH PROCESSOR ==============
// Processes items with concurrent requests limited by batchSize
// Only batchSize requests run at the same time
async function processBatch<T>(
    items: T[],
    processor: (item: T, index: number) => Promise<void>,
    batchSize: number
): Promise<void> {
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        const promises = batch.map((item, idx) => processor(item, i + idx));
        await Promise.all(promises);
    }
}

// ============== MAIN ==============
(async () => {
    try {
        let result: string[] = [];

        logger.log(`Starting search with ${CONFIG.KEYWORDS.length} keywords...`);

        const batches: string[][] = [];

        for (let i = 0; i < CONFIG.KEYWORDS.length; i += CONFIG.BATCH_SIZE) {
            batches.push(CONFIG.KEYWORDS.slice(i, i + CONFIG.BATCH_SIZE));
        }

        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
            const batch = batches[batchIndex];

            const promises = batch.map((keyword) =>
                axios.get(CONFIG.SEARCH_API_URL, {
                    params: { keyword },
                }).catch((err) => {
                    logger.error(`Failed to search "${keyword}"`, err);
                    return null;
                })
            );

            const responses = await Promise.all(promises);

            responses.forEach((res) => {
                if (res?.data?.data?.length > 0) {
                    logger.log(`Found ${res?.data?.data?.length} items (total: ${result.length})`);
                    const newItems = res?.data?.data?.filter((item: string) => !result.includes(item));
                    result.push(...newItems || []);
                }
            });

            if (result.length >= CONFIG.MAX_RESULT) {
                result = result.slice(0, CONFIG.MAX_RESULT);
                break;
            }

            if (batchIndex < batches.length - 1) {
                logger.log(`Batch ${batchIndex + 1} Done`);
            }
        }


        logger.success(`Collected ${result.length} product URLs`);
        fs.writeFileSync(
            path.join(CONFIG.FOLDER_RESULT, 'urls.json'),
            JSON.stringify(result, null, 2)
        );
        logger.log('Saved urls.json');

        // Phase 2: Fetch product details with batch processing
        let success = 0;
        let failed = 0;
        const responseTimes: number[] = [];

        await processBatch(
            result,
            async (url: string, index: number) => {
                const id = url.split('/').pop() || '';

                try {
                    const startTime = Date.now();
                    const res = await axios.get(CONFIG.PRODUCT_API_URL, {
                        params: { productUrl: url },
                    });
                    const endTime = Date.now();
                    const msResponseTime = endTime - startTime;
                    responseTimes.push(msResponseTime);

                    if (res?.data?.success) {
                        fs.writeFileSync(
                            path.join(CONFIG.FOLDER_RESULT, `${id}.json`),
                            JSON.stringify(res.data.data || {}, null, 2)
                        );
                        success++;
                        logger.log(`[${index + 1}/${result.length}] Saved ${id} finished in ${msResponseTime}ms (${(msResponseTime / 1000).toFixed(2)}s)`);
                    } else {
                        failed++;
                        logger.error(`[${index + 1}/${result.length}] Failed ${id}`);
                    }
                } catch (err) {
                    failed++;
                    logger.error(`[${index + 1}/${result.length}] Error ${id}`, err);
                }
            },
            CONFIG.BATCH_SIZE
        );

        // Calculate average response time
        const averageMsResponseTime = responseTimes.reduce((acc, cur) => acc + cur, 0) / responseTimes.length;

        logger.success(`Done! Saved ${success}/${result.length} (${((success / result.length) * 100).toFixed(2)}%), Failed ${failed}, Average Response Time ${averageMsResponseTime.toFixed(2)}ms (${(averageMsResponseTime / 1000).toFixed(2)}s)`);

    } catch (err) {
        logger.error('Fatal error', err);
        process.exit(1);
    }
})();