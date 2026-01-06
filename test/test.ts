import path from "path";
import fs from "fs";
import axios from "axios";

const FOLDER_RESULT = path.join(__dirname, 'result');

if (!fs.existsSync(FOLDER_RESULT)) {
    fs.mkdirSync(FOLDER_RESULT);
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

(async () => {
    try {
        const Keywords = ['아이폰', '갤럭시', '삼성'];
        const MAX_RESULT = 100;
        let result: string[] = [];

        logger.log(`Starting search with ${Keywords.length} keywords...`);

        for (const keyword of Keywords) {
            try {
                const res = await axios.get('http://localhost:3001/naver/search', {
                    params: { keyword },
                });
                
                if (res.data?.data?.length > 0) {
                    result.push(...res.data.data);
                    logger.log(`Found ${res.data.data.length} items for "${keyword}" (total: ${result.length})`);
                }

                if (result.length >= MAX_RESULT) {
                    result = result.slice(0, MAX_RESULT);
                    break;
                }
            } catch (err) {
                logger.error(`Failed to search "${keyword}"`, err);
            }
        }

        logger.success(`Collected ${result.length} product URLs`);

        fs.writeFileSync(path.join(FOLDER_RESULT, 'urls.json'), JSON.stringify(result, null, 2));
        logger.log('Saved urls.json');

        let success = 0;
        let failed = 0;

        for (let i = 0; i < result.length; i++) {
            const url = result[i];
            const id = url.split('/').pop() || '';

            try {
                const res = await axios.get('http://localhost:3001/naver/', {
                    params: { productUrl: url },
                });

                if (res?.data?.success) {
                    fs.writeFileSync(path.join(FOLDER_RESULT, `${id}.json`), JSON.stringify(res.data.data || {}, null, 2));
                    success++;
                    logger.log(`[${i + 1}/${result.length}] Saved ${id}`);
                } else {
                    failed++;
                    logger.error(`[${i + 1}/${result.length}] Failed ${id}`);
                }
            } catch (err) {
                failed++;
                logger.error(`[${i + 1}/${result.length}] Error ${id}`, err);
            }
        }

        logger.success(`Done! Saved ${success}/${result.length}`);

    } catch (err) {
        logger.error('Fatal error', err);
        process.exit(1);
    }
})();