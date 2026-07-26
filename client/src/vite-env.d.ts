/// <reference types="vite/client" />

declare module "*.ejs" {
    function render(env: Record<string, any>);
    export default render;
}

interface ImportMetaEnv {
    readonly VITE_ENABLE_SURVEV_ADS: boolean;
    readonly VITE_NITROPAY_SITE_ID: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}

declare module "virtual-atlases-*" {}

/** A single atlas' spritesheets — "virtual-atlas-<name>-<res>". */
declare module "virtual-atlas-*" {
    import type { ISpritesheetData } from "pixi.js-legacy";
    const sheets: ISpritesheetData[];
    export default sheets;
}
