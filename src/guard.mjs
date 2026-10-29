// Company mode has one model and one sign-in, owned by Agent Watch: Pi's own
// /login, /model, /scoped-models, /share and /bug are blocked with a message
// in Vietnamese. Pi handles these slash commands before any `input` event, so
// the editor's submit is wrapped (spike I1: docs/spikes/i1-i4 in piagent-bundle).
export const BLOCKED = /^\/(login|logout|model|scoped-models|share|bug)(\s|$)/;
const MESSAGES = {
  login: 'Đăng nhập do Agent Watch quản lý trong chế độ công ty.',
  logout: 'Đăng nhập do Agent Watch quản lý trong chế độ công ty.',
  model: 'Chế độ công ty chỉ có một model "Auto (công ty)"; Harness của team chọn model cho từng lượt.',
  'scoped-models': 'Chế độ công ty chỉ có một model "Auto (công ty)".',
  share: 'Chia sẻ hội thoại bị tắt trong chế độ công ty, vì nội dung thuộc về công ty.',
  bug: 'Báo lỗi tới Pi bị tắt trong chế độ công ty. Báo lỗi cho quản trị viên Studio.',
};

export function blockedCommand(text) {
  const match = BLOCKED.exec(String(text ?? '').trim());
  return match ? { command: `/${match[1]}`, message: `Lệnh /${match[1]} bị chặn trong chế độ công ty. ${MESSAGES[match[1]]}` } : null;
}

// An editor whose submit refuses the blocked commands. Pi assigns `onSubmit`
// after the factory returns, so the property is intercepted, not set.
export function guardedEditor(Base, notify) {
  return class GuardedEditor extends Base {
    constructor(...args) {
      super(...args);
      let inner;
      Object.defineProperty(this, 'onSubmit', {
        configurable: true,
        get: () => inner && (text => {
          const blocked = blockedCommand(text);
          if (!blocked) return inner(text);
          this.setText('');
          notify(blocked.message, 'warning');
        }),
        set: fn => { inner = fn; },
      });
    }
  };
}
