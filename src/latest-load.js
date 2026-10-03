/** Apply only the most recently requested load; release superseded resources. */
export class LatestLoad {
  constructor({ onChange = () => {} } = {}) {
    this.onChange = onChange;
    this._generation = 0;
    this._pending = false;
  }

  get pending() { return this._pending; }

  cancel() {
    ++this._generation;
    this._pending = false;
    this.onChange();
  }

  async run(read, apply, { discard = () => {} } = {}) {
    const generation = ++this._generation;
    this._pending = true;
    const current = () => generation === this._generation;
    try {
      this.onChange();
      const value = await read();
      if (!current()) {
        discard(value);
        return false;
      }
      // Ownership passes to the caller here. Keep apply synchronous so there
      // is no await between the generation check and the state mutation.
      apply(value);
      return true;
    } catch (error) {
      if (!current()) return false;
      throw error;
    } finally {
      if (current()) {
        this._pending = false;
        this.onChange();
      }
    }
  }
}
