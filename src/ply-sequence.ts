import { Events } from './events';
import { Splat } from './splat';
import { serializePly } from './splat-serialize';
import { localize } from './ui/localization';
import { FileStreamWriter } from './serialize/writer';

import { State } from './splat-state';
import { Scene } from './scene';
import { ElementType } from './element';
import { BoxShape } from './box-shape';
import { SphereShape } from './sphere-shape';

// WDD: Define the structure for export options
interface PlySequenceExportOptions {
    dirHandle: FileSystemDirectoryHandle;
    // serializeSettings could be added here in the future if needed
    // serializeSettings: SerializeSettings;
}

type SelectorDescriptor =
    | {
        kind: 'box';
        center: { x: number; y: number; z: number };
        size: { x: number; y: number; z: number };
    }
    | {
        kind: 'sphere';
        center: { x: number; y: number; z: number };
        radius: number;
    };

const getActiveSelector = (scene: Scene | null): SelectorDescriptor | null => {
    if (!scene) {
        return null;
    }

    const debugElements = scene.getElementsByType(ElementType.debug);
    const box = debugElements.find((element): element is BoxShape => element instanceof BoxShape);
    if (box) {
        const pos = box.pivot.getPosition();
        return {
            kind: 'box',
            center: { x: pos.x, y: pos.y, z: pos.z },
            size: { x: box.lenX, y: box.lenY, z: box.lenZ }
        };
    }

    const sphere = debugElements.find((element): element is SphereShape => element instanceof SphereShape);
    if (sphere) {
        const pos = sphere.pivot.getPosition();
        return {
            kind: 'sphere',
            center: { x: pos.x, y: pos.y, z: pos.z },
            radius: sphere.radius
        };
    }

    return null;
};

const applySelectorMask = (scene: Scene, splat: Splat, state: Uint8Array, selector: SelectorDescriptor) => {
    if (!scene || !state || !state.length || !selector) {
        return;
    }

    const options = selector.kind === 'box'
        ? {
            box: {
                x: selector.center.x,
                y: selector.center.y,
                z: selector.center.z,
                lenx: selector.size.x,
                leny: selector.size.y,
                lenz: selector.size.z
            }
        }
        : {
            sphere: {
                x: selector.center.x,
                y: selector.center.y,
                z: selector.center.z,
                radius: selector.radius
            }
        };

    const mask = scene.dataProcessor.intersect(options, splat);
    const limit = Math.min(state.length, mask.length);

    for (let idx = 0; idx < limit; idx++) {
        if (mask[idx] !== 255) {
            state[idx] |= State.deleted;
        } else {
            state[idx] &= ~State.deleted;
        }
    }
};

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
        if (!sequenceFiles || sequenceFiles.length === 0 || !sequenceSplat) {
            console.warn('No sequence frames to export.');
            return;
        }

        const scene = sequenceSplat.scene ?? null;
        if (!scene) {
            console.warn('Sequence splat is not attached to a scene. Aborting export.');
            return;
        }
        const activeSelector = getActiveSelector(scene);
    
        events.fire('progressStart', localize('export.export-sequence'));
 
        try { 

            const refPos = sequenceSplat.entity.getLocalPosition().clone();
            const refRot = sequenceSplat.entity.getLocalRotation().clone();
            const refScale = sequenceSplat.entity.getLocalScale().clone();

            const progressFunc = (i: number) => {
                events.fire('progressUpdate', {
                    text: `${localize('export.exporting')} ${i + 1} / ${sequenceFiles.length}`,
                    progress: 100 * (i + 1) / sequenceFiles.length
                });
            };

            progressFunc(-1);


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

                // 2. 将新加载的 splat 应用到当前场景的 splat
                // 将新加载的 splat 移动到当前场景的 splat 的位置
                splat.scene = scene;
                splat.entity.setLocalPosition(refPos);
                splat.entity.setLocalRotation(refRot);
                splat.entity.setLocalScale(refScale);
                splat.makeWorldBoundDirty();

                // 2. 创建序列化设置，确保在保存时物理移除已删除的点
                const serializeSettings = {
                    removeInvalid: true
                };

                // 3. 将状态数组应用到新加载的 splat 数据上
                if (activeSelector && scene) {
                    applySelectorMask(scene, splat, newState, activeSelector);
                } else if (oldState && oldState.length === newState.length) {
                    //  将旧状态复制到新 splat
                    newState.set(oldState);
                }

    
 
                // Get a handle to the output file in the selected directory
                const fileHandle = await options.dirHandle.getFileHandle(file.name, { create: true });
                const stream = await fileHandle.createWritable();
                const writer = new FileStreamWriter(stream);

                try {
                    // Serialize the splat data to the file stream.
                    // The settings will ensure deleted splats are not written.
                    await serializePly([splat], serializeSettings, writer);
                } finally {
                    progressFunc(i);
                    await writer.close();
                }
            }

            await events.invoke('showPopup', {
                type: 'info',
                header: localize('export.succeeded'),
                message: localize('export.sequence-success-message')
            });
        } catch (error) {
            console.error('Error during sequence export:', error);
            await events.invoke('showPopup', {
                type: 'error',
                header: localize('export.failed'),
                message: `'${error.message ?? error}'`
            });
        } finally {
            events.fire('progressEnd');
        }
    });
};

export { registerPlySequenceEvents };
