import { batchActions } from 'redux-batched-actions';
import { AppDispatch, RootState } from './store';
import { actions as uploadDialogActions } from './upload-dialog-feature';
import { actions as renameDialogActions } from './rename-dialog-feature';
import { actions as errorDialogAction } from './error-dialog-feature';
import { actions as appStateActions } from './app-feature';
import { actions as mainActions } from './main-feature';
import serviceRegistry from '../services/registry';
import { Wireformat } from 'netmd-js';
import { AnyAction } from '@reduxjs/toolkit';

export function pair() {
    return async function(dispatch: AppDispatch, getState: () => RootState) {
        dispatch(appStateActions.setPairingFailed(false));

        await serviceRegistry.audioExportService!.init();

        try {
            let connected = await serviceRegistry.netmdService!.connect();
            if (connected) {
                dispatch(appStateActions.setState('MAIN'));
                return;
            }
        } catch (err) {
            console.error(err);
            // In case of error, just log and try to pair
        }

        try {
            let paired = await serviceRegistry.netmdService!.pair();
            if (paired) {
                dispatch(appStateActions.setState('MAIN'));
                return;
            }
            dispatch(batchActions([appStateActions.setPairingMessage(`Connection Failed`), appStateActions.setPairingFailed(true)]));
        } catch (err) {
            console.error(err);
            let message = (err as Error).message;
            dispatch(batchActions([appStateActions.setPairingMessage(message), appStateActions.setPairingFailed(true)]));
        }
    };
}

export function listContent() {
    return async function(dispatch: AppDispatch) {
        // Issue loading
        dispatch(appStateActions.setLoading(true));
        let disc = await serviceRegistry.netmdService!.listContent();
        let deviceName = await serviceRegistry.netmdService!.getDeviceName();
        dispatch(batchActions([mainActions.setDisc(disc), mainActions.setDeviceName(deviceName), appStateActions.setLoading(false)]));
    };
}

export function renameTrack({ index, newName }: { index: number; newName: string }) {
    return async function(dispatch: AppDispatch) {
        const { netmdService } = serviceRegistry;
        await netmdService!.renameTrack(index, newName);
        dispatch(renameDialogActions.setVisible(false));
        listContent()(dispatch);
    };
}

export function deleteTracks(indexes: number[]) {
    return async function(dispatch: AppDispatch) {
        const { netmdService } = serviceRegistry;
        dispatch(appStateActions.setLoading(true));
        indexes = indexes.sort();
        indexes.reverse();
        for (let index of indexes) {
            await netmdService!.deleteTrack(index);
        }
        listContent()(dispatch);
    };
}

export function wipeDisc() {
    return async function(dispatch: AppDispatch) {
        const { netmdService } = serviceRegistry;
        dispatch(appStateActions.setLoading(true));
        await netmdService!.wipeDisc();
        listContent()(dispatch);
    };
}

export const WireformatDict: { [k: string]: Wireformat } = {
    SP: Wireformat.pcm,
    LP2: Wireformat.lp2,
    LP105: Wireformat.l105kbps,
    LP4: Wireformat.lp4,
};

export function convertAndUpload(files: File[], format: string) {
    return async function(dispatch: AppDispatch, getState: (state: RootState) => void) {
        const { audioExportService, netmdService } = serviceRegistry;
        const wireformat = WireformatDict[format];

        dispatch(uploadDialogActions.setVisible(true));

        const updateProgressCallback = ({ written, encrypted, total }: { written: number; encrypted: number; total: number }) => {
            dispatch(uploadDialogActions.setWriteProgress({ written, encrypted, total }));
        };

        let trackUpdate: {
            current: number;
            converting: number;
            total: number;
            titleCurrent: string;
            titleConverting: string;
        } = {
            current: 0,
            converting: 0,
            total: files.length,
            titleCurrent: '',
            titleConverting: '',
        };
        const updateTrack = () => {
            dispatch(uploadDialogActions.setTrackProgress(trackUpdate));
        };

        let conversionIterator = async function*(files: File[]) {
            let converted: Promise<{ file: File; data: ArrayBuffer }>[] = [];

            let i = 0;
            function convertNext() {
                if (i === files.length) {
                    trackUpdate.converting = i;
                    trackUpdate.titleConverting = ``;
                    updateTrack();
                    return;
                }

                let f = files[i];
                trackUpdate.converting = i;
                trackUpdate.titleConverting = f.name;
                updateTrack();
                i++;

                converted.push(
                    new Promise(async (resolve, reject) => {
                        let data: ArrayBuffer;
                        try {
                            await audioExportService!.prepare(f);
                            data = await audioExportService!.export({ format });
                            convertNext();
                            resolve({ file: f, data: data });
                        } catch (err) {
                            error = err;
                            errorMessage = `${f.name}: Unsupported or unrecognized format`;
                            reject(err);
                        }
                    })
                );
            }
            convertNext();

            let j = 0;
            while (j < converted.length) {
                yield await converted[j];
                j++;
            }
        };

        let error: any;
        let errorMessage = ``;
        let i = 1;
        for await (let item of conversionIterator(files)) {
            const { file, data } = item;

            trackUpdate.current = i++;
            trackUpdate.titleCurrent = file.name;
            updateTrack();
            updateProgressCallback({ written: 0, encrypted: 0, total: 100 });
            try {
                await netmdService?.upload(file.name, data, wireformat, updateProgressCallback);
            } catch (err) {
                error = err;
                errorMessage = `${file.name}: Error uploading to device`;
                break;
            }
        }

        let actionToDispatch: AnyAction[] = [uploadDialogActions.setVisible(false)];

        if (error) {
            console.error(error);
            actionToDispatch = actionToDispatch.concat([
                errorDialogAction.setVisible(true),
                errorDialogAction.setErrorMessage(errorMessage),
            ]);
        }

        dispatch(batchActions(actionToDispatch));
        listContent()(dispatch);
    };
}
