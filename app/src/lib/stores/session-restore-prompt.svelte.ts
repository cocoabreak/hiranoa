function createSessionRestorePromptStore() {
  let visible = $state(false);
  let restoring = $state(false);

  return {
    get restoring() {
      return restoring;
    },
    beginRestore() {
      restoring = true;
    },
    endRestore() {
      restoring = false;
    },
    get visible() {
      return visible;
    },
    show() {
      visible = true;
    },
    hide() {
      visible = false;
    },
  };
}

export const sessionRestorePromptStore = createSessionRestorePromptStore();
