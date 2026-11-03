/**
 * Assets-panel "Create" menu contribution.
 */

import { createEffect } from './main';

declare const Editor: {
    Panel: { open(name: string): Promise<boolean> };
};

export interface IMenuAssetInfo {
    url?: string;
    isDirectory?: boolean;
}

export interface ICreateMenuItem {
    label: string;
    click: () => void;
}

export function onCreateMenu(assetInfo?: IMenuAssetInfo): ICreateMenuItem[] {
    return [
        {
            label: 'i18n:pts-effect.asset.create',
            click: () => {
                void (async () => {
                    const result = await createEffect(assetInfo);
                    if (result.ok) {
                        void Editor.Panel.open('pts-effect');
                    } else if (result.error) {
                        console.error('[pts-effect] createEffect failed:', result.error);
                    }
                })();
            },
        },
    ];
}
