import { Injectable } from '@nestjs/common';
import Anthropic from "@anthropic-ai/sdk";
import fs from 'fs';
import path from 'path';

@Injectable()
export class CaptchaSolverService {
    private client: Anthropic;

    constructor() {
        this.client = new Anthropic({
            apiKey: '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',
        });
    }

    async solveCaptcha(dataURI: string, question: string) {
        const message = await this.client.messages.create({
            model: "claude-sonnet-4-5",
            max_tokens: 1024,
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "image",
                            source: {
                                type: "base64",
                                media_type: "image/jpeg",
                                data: dataURI?.split(',')[1],
                            },
                        },
                        {
                            type: "text",
                            text: `${question}`,
                        },
                    ],
                },
            ],
            system: "Answer ONLY with the direct answer. No explanation, no preamble, no additional text.",
        });

        return message.content[0].type === 'text' && message.content[0].text;
    }
}




// const client = new Anthropic({
//     apiKey: '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',
// });

// function getMediaType(filePath) {
//     const ext = path.extname(filePath).toLowerCase();
//     if (ext === ".png") return "image/png";
//     if (ext === ".webp") return "image/webp";
//     return "image/jpeg";
// }

// async function analyzeDataURIImage(dataURI, question) {
//     console.log(dataURI);
//     console.log(typeof dataURI);
//     // convert to buffer
//     const buffer = Buffer.from(dataURI?.split(',')[1], 'base64');
//     fs.writeFileSync('captcha.png', buffer);
//     const imageBuffer = fs.readFileSync('captcha.png');
//     const base64Data = imageBuffer.toString('base64');

//     const message = await client.messages.create({
//         model: "claude-sonnet-4-5",
//         max_tokens: 1024,
//         messages: [
//             {
//                 role: "user",
//                 content: [
//                     {
//                         type: "image",
//                         source: {
//                             type: "base64",
//                             media_type: "image/jpeg",
//                             data: base64Data,
//                         },
//                     },
//                     {
//                         type: "text",
//                         text: `${question}`,
//                     },
//                 ],
//             },
//         ],
//         system: "Answer ONLY with the direct answer. No explanation, no preamble, no additional text.",
//     });

//     return message.content[0].type === 'text' && message.content[0].text;
// }

// export { analyzeDataURIImage };