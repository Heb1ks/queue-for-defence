// Supabase SDK 2.118.0 is vendored under MIT. It loads only for live connections.
const SDK_URL = new URL('../vendor/supabase-2.118.0.js', import.meta.url).href;
let sdkLoading;

const MESSAGES = {
  NOT_CONFIGURED: 'Сайт пока не подключён к базе. Попробуй демонстрационный режим.',
  INVALID_CONFIG: 'Настройки подключения к базе некорректны. Сообщи администратору.',
  SDK_UNAVAILABLE: 'Не удалось загрузить подключение к базе. Обнови страницу.',
  NETWORK: 'Нет связи с сервером. Проверь интернет и попробуй ещё раз.',
  SETUP_REQUIRED: 'База ещё не настроена. Сообщи администратору.',
  INVALID_RESPONSE: 'Сервер вернул неполный ответ. Попробуй обновить страницу.',
  SESSION_EXPIRED: 'Сессия закончилась. Войди снова.',
  UNAUTHENTICATED: 'Сначала войди на сайт.',
  NOT_REGISTERED: 'Для этой сессии ещё не выбран студент. Войди снова.',
  NO_STUDENT_SESSION: 'Войди по данным студента.',
  STUDENT_NOT_FOUND: 'Студент не найден. Проверь ФИО, группу и код студента.',
  INVALID_CREDENTIALS: 'Не совпадают ФИО, группа или код студента.',
  INVALID_LOGIN: 'Не совпадают ФИО, группа или код студента.',
  INVALID_STUDENT: 'Не совпадают ФИО, группа или код студента.',
  INVALID_INPUT: 'Проверь заполненные поля.',
  STUDENT_INACTIVE: 'Доступ студента отключён. Обратись к администратору.',
  ANONYMOUS_AUTH_DISABLED: 'Вход пока не настроен. Сообщи администратору.',
  FORBIDDEN: 'Это действие доступно только администратору группы.',
  RATE_LIMIT: 'Слишком много попыток. Подожди немного и повтори.',
  RATE_LIMITED: 'Слишком много попыток входа. Подожди немного и повтори.',
  BUSY: 'Предыдущее действие ещё выполняется.',
  QUEUE_NOT_FOUND: 'Эта очередь уже недоступна. Обнови список.',
  SUBJECT_NOT_FOUND: 'Предмет не найден. Обнови список.',
  QUEUE_CLOSED: 'Запись в эту очередь закрыта.',
  QUEUE_NOT_OPEN: 'Запись в эту очередь ещё не открыта или уже закрыта.',
  QUEUE_FULL: 'В очереди больше нет свободных мест.',
  ALREADY_JOINED: 'Ты уже записан в эту очередь.',
  NOT_ENROLLED: 'Тебя уже нет в этой очереди.',
  NOT_JOINED: 'Тебя уже нет в этой очереди.',
  ENTRY_NOT_FOUND: 'Участник уже вышел из очереди.',
  CURRENT_CANNOT_LEAVE: 'Сейчас твоя защита. Администратор вызовет следующего.',
  CURRENT_STUDENT_CANNOT_LEAVE: 'Сейчас твоя защита. Администратор вызовет следующего.',
  STALE_QUEUE: 'Очередь уже изменилась. Проверь актуальный список и повтори действие.',
  STALE_REVISION: 'Очередь уже изменилась. Проверь актуальный список и повтори действие.',
  QUEUE_CHANGED: 'Очередь уже изменилась. Проверь актуальный список и повтори действие.',
  SUBJECT_EXISTS: 'Предмет с таким названием уже существует.',
  DUPLICATE_SUBJECT: 'Предмет с таким названием уже существует.',
  DUPLICATE_QUEUE: 'На это время уже есть очередь по выбранному предмету.',
  DUPLICATE: 'Такая запись уже существует. Обнови список.',
  SCHEDULE_NOT_FOUND: 'Это расписание уже удалено. Обнови список.',
  LIMIT_REACHED: 'Достигнуто максимальное количество записей.',
  INVALID_ACTION: 'Это действие не поддерживается. Обнови страницу.',
  UNKNOWN_ACTION: 'Это действие не поддерживается. Обнови страницу.',
};

export class AppError extends Error {
  constructor(code = 'UNKNOWN', retryAfter = 0, options = {}) {
    const seconds = Math.max(0, Math.ceil(Number(retryAfter) || 0));
    const message = code === 'COOLDOWN'
      ? `Подожди ещё ${seconds || 5} сек. перед следующим действием.`
      : MESSAGES[code] || 'Не удалось выполнить действие. Попробуй ещё раз.';
    super(message, options);
    this.name = 'AppError';
    this.code = code;
    this.retryAfter = seconds;
    this.retry_after = seconds;
  }
}

export function readableError(error) {
  return toAppError(error).message;
}

function toAppError(error) {
  if (error instanceof AppError) return error;
  const source = error?.error || error || {};
  const raw = String(source.message || source.code || '');
  const code = String(source.code || '');
  if (code === 'PGRST202' || code === 'PGRST205' || /could not find the function/i.test(raw)) {
    return new AppError('SETUP_REQUIRED');
  }
  if (/anonymous.*(disabled|not allowed)/i.test(raw)) return new AppError('ANONYMOUS_AUTH_DISABLED');
  if (code === 'RATE_LIMITED') return new AppError('RATE_LIMITED', source.retry_after);
  if (Number(source.status) === 429 || /over_.*rate_limit|rate_limit|too many requests/i.test(code + raw)) {
    return new AppError('RATE_LIMIT', source.retry_after);
  }
  if (Number(source.status) === 401 || /refresh_token_not_found|refresh_token_already_used|bad_jwt/i.test(code)) {
    return new AppError('SESSION_EXPIRED');
  }
  if (Number(source.status) === 403 || code === '42501') return new AppError('FORBIDDEN');
  const machine = /^(?:error:\s*)?([A-Z][A-Z_]+)(?::([\d.]+))?$/.exec(raw);
  if (machine) return new AppError(machine[1], source.retry_after ?? machine[2]);
  if (MESSAGES[code] || code === 'COOLDOWN') return new AppError(code, source.retry_after);
  if (source instanceof TypeError || /fetch|network|failed to load|offline|timeout/i.test(raw)) {
    return new AppError('NETWORK');
  }
  return new AppError('UNKNOWN');
}

async function loadSdk() {
  if (globalThis.supabase?.createClient) return globalThis.supabase;
  if (!sdkLoading) {
    sdkLoading = new Promise((resolve, reject) => {
      if (!globalThis.document) {
        reject(new AppError('SDK_UNAVAILABLE'));
        return;
      }
      const script = document.createElement('script');
      const timer = setTimeout(() => finish(new AppError('SDK_UNAVAILABLE')), 15000);
      let finished = false;
      function finish(error) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        script.onload = script.onerror = null;
        if (error) {
          script.remove();
          reject(error);
        } else if (globalThis.supabase?.createClient) resolve(globalThis.supabase);
        else reject(new AppError('SDK_UNAVAILABLE'));
      }
      script.src = SDK_URL;
      script.async = true;
      script.onload = () => finish();
      script.onerror = () => finish(new AppError('SDK_UNAVAILABLE'));
      document.head.append(script);
    }).catch(error => {
      sdkLoading = undefined;
      throw error;
    });
  }
  return sdkLoading;
}

function publicConfiguration(config = {}) {
  const url = String(config.supabaseUrl || '').trim().replace(/\/+$/, '');
  const key = String(config.supabasePublishableKey || config.supabaseAnonKey || '').trim();
  if (!url || !key) return { configured: false, url, key };
  try {
    const parsed = new URL(url);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) throw new Error();
    if (key.startsWith('sb_secret_')) throw new Error();
    if (key.split('.').length === 3) {
      const payload = key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const role = JSON.parse(atob(payload)).role;
      if (role && role !== 'anon') throw new Error();
    }
    return { configured: true, url, key };
  } catch {
    return { configured: false, invalid: true, url, key };
  }
}

/**
 * Live interface. No configuration or connection failure ever switches to demo.
 * options.client / options.loadSdk / timer hooks are intended for deterministic tests.
 */
export function createLiveApi(config = {}, options = {}) {
  const connection = publicConfiguration(config);
  const page = options.document ?? globalThis.document;
  const schedule = options.setTimeout ?? globalThis.setTimeout;
  const cancel = options.clearTimeout ?? globalThis.clearTimeout;
  const listeners = new Set();
  let clientPromise, client, lastState, channel, channelGroup, watching = false;
  let connected = false, pollTimer, eventTimer, stateRequest, mutationPending = false;
  let requestSerial = 0, acceptedSerial = 0, generation = 0, destroyed = false;

  const visible = () => !page || page.visibilityState !== 'hidden';
  const status = value => options.onStatus?.(value);

  async function getClient() {
    if (destroyed) throw new AppError('SESSION_EXPIRED');
    if (!connection.configured) throw new AppError(connection.invalid ? 'INVALID_CONFIG' : 'NOT_CONFIGURED');
    if (!clientPromise) {
      clientPromise = (async () => {
        const sdk = options.client ? null : await (options.loadSdk || loadSdk)();
        client = options.client || sdk.createClient(connection.url, connection.key, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
        });
        return client;
      })().catch(error => {
        clientPromise = undefined;
        throw toAppError(error);
      });
    }
    return clientPromise;
  }

  async function rpc(name, parameters) {
    try {
      const sdk = await getClient();
      const result = await sdk.rpc(name, parameters);
      if (result.error) throw toAppError(result.error);
      if (result.data?.error) throw toAppError(result.data.error);
      return result.data;
    } catch (error) {
      throw toAppError(error);
    }
  }

  function accept(data, serial) {
    if (!data?.user?.id || !data?.group?.id || !Array.isArray(data.queues)
        || !Array.isArray(data.subjects) || !Array.isArray(data.schedules)) {
      throw new AppError('INVALID_RESPONSE');
    }
    if (serial >= acceptedSerial) {
      acceptedSerial = serial;
      lastState = data;
      if (watching && channelGroup !== data.group.id) {
        disconnectChannel();
        void connectChannel();
      }
    }
    return lastState;
  }

  async function state() {
    if (!stateRequest) {
      const serial = ++requestSerial;
      stateRequest = rpc('queue_api', { p_action: 'state', p_payload: {} })
        .then(data => accept(data, serial))
        .finally(() => { stateRequest = undefined; });
    }
    return stateRequest;
  }

  async function login(fields) {
    const sdk = await getClient();
    try {
      const session = await sdk.auth.getSession();
      if (session.error) throw session.error;
      if (!session.data?.session) {
        const result = await sdk.auth.signInAnonymously();
        if (result.error) throw result.error;
        if (!result.data?.session) throw new AppError('SESSION_EXPIRED');
      }
      const serial = ++requestSerial;
      const data = await rpc('sign_in_student', {
        p_first_name: String(fields.first_name || '').trim(),
        p_last_name: String(fields.last_name || '').trim(),
        p_group_code: String(fields.group_code || '').trim(),
        p_student_code: String(fields.student_code || '').trim(),
      });
      return accept(data, serial);
    } catch (error) {
      throw toAppError(error);
    }
  }

  async function restore() {
    if (!connection.configured) return null;
    try {
      const sdk = await getClient();
      const session = await sdk.auth.getSession();
      if (session.error) throw session.error;
      if (!session.data?.session) return null;
      return await state();
    } catch (error) {
      const normalized = toAppError(error);
      if (['NOT_REGISTERED', 'NO_STUDENT_SESSION', 'UNAUTHENTICATED', 'SESSION_EXPIRED',
        'STUDENT_NOT_FOUND', 'STUDENT_INACTIVE'].includes(normalized.code)) return null;
      throw normalized;
    }
  }

  async function mutate(action, payload = {}) {
    if (mutationPending) throw new AppError('BUSY');
    mutationPending = true;
    const serial = ++requestSerial;
    try {
      return accept(await rpc('queue_api', { p_action: action, p_payload: payload }), serial);
    } finally {
      mutationPending = false;
    }
  }

  async function refreshListeners() {
    if (!watching || !visible() || !listeners.size) return;
    try {
      const data = await state();
      if (watching && visible()) for (const listener of listeners) listener.onChange(data);
    } catch (error) {
      status('offline');
      for (const listener of listeners) listener.onError?.(toAppError(error));
    }
  }

  function queueRefresh() {
    if (eventTimer || !watching || !visible()) return;
    eventTimer = schedule(() => {
      eventTimer = undefined;
      void refreshListeners();
    }, 180);
  }

  function disconnectChannel() {
    generation++;
    connected = false;
    if (channel && client) void client.removeChannel(channel).catch(() => {});
    channel = undefined;
    channelGroup = undefined;
  }

  async function connectChannel() {
    if (channel || !watching || !visible() || !lastState?.group?.id) return;
    const currentGeneration = generation;
    const group = lastState.group.id;
    try {
      const sdk = await getClient();
      if (!watching || !visible() || currentGeneration !== generation || channel) return;
      channelGroup = group;
      channel = sdk.channel(`group-updates:${group}`)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public',
          table: 'group_revisions', filter: `group_id=eq.${group}` }, queueRefresh)
        .subscribe(value => {
          if (!watching || currentGeneration !== generation) return;
          connected = value === 'SUBSCRIBED';
          status(connected ? 'online' : 'connecting');
        });
    } catch {
      status('offline');
    }
  }

  function poll() {
    if (!watching) return;
    pollTimer = schedule(async () => {
      pollTimer = undefined;
      if (visible() && !connected) {
        await refreshListeners();
        void connectChannel();
      }
      poll();
    }, 30000);
  }

  function visibilityChanged() {
    if (visible()) {
      void connectChannel();
      void refreshListeners();
    } else {
      disconnectChannel();
      if (eventTimer) cancel(eventTimer);
      eventTimer = undefined;
    }
  }

  function stopWatching() {
    watching = false;
    disconnectChannel();
    if (pollTimer) cancel(pollTimer);
    if (eventTimer) cancel(eventTimer);
    pollTimer = eventTimer = undefined;
    page?.removeEventListener('visibilitychange', visibilityChanged);
  }

  function subscribe(onChange, onError) {
    const listener = { onChange, onError };
    listeners.add(listener);
    if (!watching) {
      watching = true;
      page?.addEventListener('visibilitychange', visibilityChanged);
      poll();
      void connectChannel();
    }
    return () => {
      listeners.delete(listener);
      if (!listeners.size) stopWatching();
    };
  }

  async function logout() {
    stopWatching();
    listeners.clear();
    if (clientPromise) {
      try {
        const sdk = await getClient();
        const result = await sdk.auth.signOut({ scope: 'local' });
        if (result.error) throw result.error;
      } catch (error) {
        const normalized = toAppError(error);
        if (normalized.code !== 'SESSION_EXPIRED') throw normalized;
      }
    }
    lastState = undefined;
    acceptedSerial = ++requestSerial;
  }

  function destroy() {
    stopWatching();
    listeners.clear();
    destroyed = true;
  }

  return { isConfigured: connection.configured, mode: 'live',
    login, restore, state, mutate, subscribe, logout, destroy };
}
