// Minimal ambient declarations for JS-only deps used from the TS server tree.
// Both are consumed through explicitly-typed call sites (modules/assets), so
// `any` here is contained.
declare module 'multer';
declare module 'mime-types';
