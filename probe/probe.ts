const random = {
    read(bytes: Uint8Array) {
        crypto.getRandomValues(bytes);
    },
};
export const _ = random;
