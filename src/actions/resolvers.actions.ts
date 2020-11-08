import * as glob from 'glob';
import fs from 'fs-extra';
import path from 'path';
import { showReading, showGenerated } from '../utils/logger.util';
import { store } from '../store';
import * as compiler from '../compiler';

export async function resolversActions(): Promise<any>  {
    if (store.inputFiles && store.outputResolversDir) {
        const files = glob.sync(store.inputFiles);
        files.forEach(async file => {
            showReading(file);

            if (compiler.foundSchema(file)) {
                const fileName = path.basename(file, '.ts');
                const outputFilePath = path.resolve(path.join(store.outputResolversDir, `${fileName}.resolvers.ts`));

                await fs.createFile(outputFilePath)
                const writeStream = fs.createWriteStream(outputFilePath);
                compiler.emit(file, [], writeStream);

                showGenerated(outputFilePath);
            }
        });

        return;
    }
}
