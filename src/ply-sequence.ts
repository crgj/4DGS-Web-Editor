import { Events } from './events';
import { Splat } from './splat';
import { serializePly } from './splat-serialize';
import { FileStreamWriter } from './serialize/writer';

import { State } from './splat-state';

// WDD: Define the structure for export options
interface PlySequenceExportOptions {
    dirHandle: FileSystemDirectoryHandle;
    // serializeSettings could be added here in the future if needed
    // serializeSettings: SerializeSettings;
}
const registerPlySequenceEvents = (events: Events) => {
    let sequenceFiles: File[] = [];
    let sequenceSplat: Splat = null;
    let sequenceFrame = -1;
    let sequenceLoading = false;
    let nextFrame = -1;

    const setFrames = (files: File[]) => {
        // eslint-disable-next-line regexp/no-super-linear-backtracking
        const regex = /(.*?)(\d+)(?:\.compressed)?\.ply$/;

        // sort frames by trailing number, if it exists
        const sorter = (a: File, b: File) => {
            const avalue = a.name?.toLowerCase().match(regex)?.[2];
            const bvalue = b.name?.toLowerCase().match(regex)?.[2];
            return (avalue && bvalue) ? parseInt(avalue, 10) - parseInt(bvalue, 10) : 0;
        };

        sequenceFiles = files.slice();
        sequenceFiles.sort(sorter);
        events.fire('timeline.frames', sequenceFiles.length);
    };

    // resolves on first render frame
    const firstRender = (splat: Splat) => {
        return new Promise<void>((resolve) => {
            splat.entity.gsplat.instance.sorter.on('updated', (count) => {
                resolve();
            });
        });
    };

    const setFrame = async (frame: number) => {
        if (frame < 0 || frame >= sequenceFiles.length) {
            return;
        }

        if (sequenceLoading) {
            nextFrame = frame;
            return;
        }

        if (frame === sequenceFrame) {
            return;
        }

        // if user changed the scene, confirm
        if (events.invoke('scene.dirty')) {
            const result = await events.invoke('showPopup', {
                type: 'yesno',
                header: 'RESET SCENE',
                message: 'You have unsaved changes. Are you sure you want to reset the scene?'
            });

            if (result.action !== 'yes') {
                return;
            }

            events.fire('scene.clear');
            sequenceSplat = null;
        }

        sequenceLoading = true;

        const file = sequenceFiles[frame];
        const newSplat = await events.invoke('import', [{
            filename: file.name,
            contents: file
        }], true) as Splat[];


        console.log('Loaded frame', newSplat);



        // wait for first frame render
        await firstRender(newSplat[0]);

        // destroy the previous frame
        if (sequenceSplat) {
            sequenceSplat.destroy();
        }
        sequenceFrame = frame;
        sequenceSplat = newSplat[0];
        sequenceLoading = false;

        // initiate the next frame load
        if (nextFrame !== -1) {
            const frame = nextFrame;
            nextFrame = -1;
            setFrame(frame);
        }
    };

    events.on('plysequence.setFrames', (files: File[]) => {
        setFrames(files);
    });

    events.on('timeline.frame', async (frame: number) => {
        await setFrame(frame);
    });

    // WDD: Add handler for the plysequence.export event
    events.function('plysequence.export', async (options: PlySequenceExportOptions) => {
        if (!sequenceFiles || sequenceFiles.length === 0) {
            console.warn('No sequence frames to export.');
            return;
        }

        events.fire('startSpinner');

        try {
            for (let i = 0; i < sequenceFiles.length; i++) {
                const file = sequenceFiles[i];
                // WDD: Use the scene's assetLoader to load the splat data into a temporary object.
                // This correctly loads the data without adding the splat to the main scene.
                const splat = await events.invoke('scene.assetLoader').load({
                    filename: file.name,
                    contents: file
                });

                // WDD: 保存序列文件的时候 对照当前场景中splat的高斯点状态
                // 如果高斯点的状态是被删除的 则不写入文件

                
                // 1. 从当前场景的 splat (sequenceSplat) 获取完整的状态数组
                const oldState = sequenceSplat.splatData.getProp('state') as Uint8Array;
                const newState = splat.splatData.getProp('state') as Uint8Array;
               

                console.log('state 000',  splat.splatData);

                // 2. 将状态数组应用到新加载的 splat 数据上
                if (oldState) {
                    //  将旧状态复制到新 splat
                    newState.set(oldState);

                     
                }


                console.log('state 111',  splat.splatData);

                // 3. 创建序列化设置，确保在保存时物理移除已删除的点
                const serializeSettings = {
                    removeInvalid: true
                };

                // Get a handle to the output file in the selected directory
                const fileHandle = await options.dirHandle.getFileHandle(file.name, { create: true });
                const stream = await fileHandle.createWritable();
                const writer = new FileStreamWriter(stream);

                try {
                    // Serialize the splat data to the file stream.
                    // The settings will ensure deleted splats are not written.
                    await serializePly([splat], serializeSettings, writer);
                } finally {
                    await writer.close();
                }
            }
        } catch (error) {
            console.error('Error during sequence export:', error);
        } finally {
            events.fire('stopSpinner');
        }
    });
};

export { registerPlySequenceEvents };
