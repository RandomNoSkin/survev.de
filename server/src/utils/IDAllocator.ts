/**
 * Class to manage entity ID's
 */
export class IDAllocator {
    readonly maxId: number;
    private _currentId = 1;
    /**
     * A list of free ID's to be used once the main ID's run out
     */
    private readonly _freeList: number[] = [];
    /**
     * Mirrors {@link _freeList} so a double `give()` can't hand the same ID to two owners.
     * For group IDs that would silently make two strangers share a teamId, i.e. count as
     * teammates and be unable to damage each other.
     */
    private readonly _freeSet = new Set<number>();

    constructor(maxId: number) {
        this.maxId = maxId;
    }

    /**
     * Gets the next available ID
     * If the current ID is higher than the max ID it will start using the free list ID's
     * @throws {Error} If the there's no ID's left
     */
    getNextId(): number {
        let id: number | undefined = this._currentId;
        if (id > this.maxId) {
            id = this._freeList.shift();
            if (id) {
                this._freeSet.delete(id);
                return id;
            }
            throw new Error("Ran out of ID's");
        }
        this._currentId++;
        return id;
    }

    /**
     * Gives an ID back to the allocator so it can be reused once it runs out of ID's
     * Giving back an ID that is already free is a no-op
     */
    give(id: number) {
        if (id <= 0 || id > this.maxId) {
            throw new Error(`ID out of range: ${id}, range: [1, ${this.maxId}]`);
        }
        if (this._freeSet.has(id)) return;
        this._freeSet.add(id);
        this._freeList.push(id);
    }
}
