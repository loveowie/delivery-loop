/* Delivery Loop client: run dock, full delivery view, and settings page. */
window.__ModuleLoader__.load({
  id: 'delivery-loop',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useMemo, useRef, useState } = React;

    const NS = 'delivery-loop';
    const API = '/delivery-loop/api';
    const TOKEN = typeof window !== 'undefined' && typeof window.__DELIVERY_LOOP_TOKEN__ === 'string'
      ? window.__DELIVERY_LOOP_TOKEN__
      : '';
    const OPEN_EVENT = 'delivery-loop:open';
    const TOOL_NAMES = [
      'delivery_start', 'delivery_status', 'delivery_inspect', 'delivery_watch',
      'delivery_respond', 'delivery_pause', 'delivery_resume', 'delivery_cancel',
      'delivery_export_report', 'delivery_finalize',
    ];

    const zh = {
      nav: '交付循环',
      'settings.title': '交付循环',
      'settings.subtitle': '查看已批准的端到端交付运行：任务图、每次决策、变更文件与验收证据。',
      'settings.empty': '还没有交付运行。使用 deliver-change 技能准备并启动一个运行。',
      'dock.open': '打开交付视图',
      'dock.noRun': '暂无运行',
      'overview': '概览',
      'tasks': '任务',
      'decisions': '决策',
      'files': '文件',
      'artifacts': '产物',
      'events': '事件',
      'run': '运行',
      'progress': '进度',
      'status': '状态',
      'tokens': 'Token',
      'pending': '待人工决策',
      'current': '当前任务',
      'lastError': '最近错误',
      'spec': '规格摘要',
      'noSpec': '没有规格摘要。',
      'noError': '没有错误。',
      'noPending': '没有等待人工处理的决策。',
      'noTasks': '没有任务。',
      'noDecisions': '还没有记录决策。',
      'noFiles': '还没有变更文件。',
      'noArtifacts': '没有运行产物。',
      'noEvents': '没有事件。',
      'refresh': '刷新',
      'close': '关闭',
      'pause': '暂停',
      'resume': '恢复',
      'cancel': '取消',
      'cancelConfirm': '取消该交付运行？未完成的任务会被标记为已取消，此操作不可撤销。',
      'export': '导出报告',
      'answer': '提交',
      'approve': '通过',
      'reject': '拒绝',
      'answerPlaceholder': '输入决策结果…',
      'loading': '加载中…',
      'preview': '预览',
      'diff': 'Diff',
      'back': '返回',
      'binary': '二进制文件，无法以文本预览。',
      'truncated': '内容已截断。',
      'clickFile': '从左侧选择文件查看内容。',
      'selectRun': '选择运行',
      'updated': '更新于',
      'attempt': '尝试',
      'role': '角色',
      'origin': '来源',
      'changedFiles': '变更文件',
      'failure': '失败上下文',
      'dependencies': '依赖',
      'verification': '验证命令',
      'workspace': '工作区',
      'worktree': '工作区',
      'repo': '仓库',
      'timeline': '决策时间线',
      'phase': '阶段',
      'outcome': '结果',
      'systemEvents': '系统事件',
      'taskCounts': '任务分布',
      'noSelection': '未选择',
      'openFromSettings': '查看',
      'runList': '运行列表',
      'error.LoadFailed': '加载失败',
      'error.ActionFailed': '操作失败',
      'acceptanceRejectHint': '拒绝只会记录这次人工决策；运行仍会等待验收通过。',
      'tool.notIndexed': '运行尚未出现在索引中，请从设置页刷新。',
      'status.DRAFT': '草稿',
      'status.SPEC_READY': '规格就绪',
      'status.QUEUED': '排队中',
      'status.PLANNING': '规划中',
      'status.RUNNING': '执行中',
      'status.VERIFYING': '验证中',
      'status.WAITING_HUMAN': '等待人工',
      'status.BLOCKED': '已阻塞',
      'status.PAUSED': '已暂停',
      'status.COMPLETED': '已完成',
      'status.CANCELLED': '已取消',
      'phase.prepare': '准备',
      'phase.dispatch': '调度',
      'phase.execute': '执行',
      'phase.verify': '验证',
      'phase.review': '评审',
      'phase.integrate': '集成',
      'phase.accept': '验收',
      'phase.human': '人工',
      'phase.lifecycle': '生命周期',
      'phase.system': '系统',
    };

    const en = {
      nav: 'Delivery loop',
      'settings.title': 'Delivery loop',
      'settings.subtitle': 'Inspect approved end-to-end delivery runs: task graph, every decision, changed files, and acceptance evidence.',
      'settings.empty': 'No delivery runs yet. Prepare and start one with the deliver-change skill.',
      'dock.open': 'Open delivery view',
      'dock.noRun': 'No run',
      'overview': 'Overview',
      'tasks': 'Tasks',
      'decisions': 'Decisions',
      'files': 'Files',
      'artifacts': 'Artifacts',
      'events': 'Events',
      'run': 'Run',
      'progress': 'Progress',
      'status': 'Status',
      'tokens': 'Tokens',
      'pending': 'Pending decisions',
      'current': 'Current tasks',
      'lastError': 'Last error',
      'spec': 'Specification excerpt',
      'noSpec': 'No specification excerpt.',
      'noError': 'No error.',
      'noPending': 'No decisions are waiting for a human.',
      'noTasks': 'No tasks.',
      'noDecisions': 'No decisions recorded yet.',
      'noFiles': 'No changed files yet.',
      'noArtifacts': 'No run artifacts.',
      'noEvents': 'No events.',
      'refresh': 'Refresh',
      'close': 'Close',
      'pause': 'Pause',
      'resume': 'Resume',
      'cancel': 'Cancel',
      'cancelConfirm': 'Cancel this delivery run? Unfinished tasks become cancelled; this cannot be undone.',
      'export': 'Export report',
      'answer': 'Submit',
      'approve': 'Approve',
      'reject': 'Reject',
      'answerPlaceholder': 'Enter the decision result…',
      'loading': 'Loading…',
      'preview': 'Preview',
      'diff': 'Diff',
      'back': 'Back',
      'binary': 'Binary file; no text preview.',
      'truncated': 'Content truncated.',
      'clickFile': 'Choose a file on the left to preview it.',
      'selectRun': 'Select a run',
      'updated': 'Updated',
      'attempt': 'Attempt',
      'role': 'Role',
      'origin': 'Origin',
      'changedFiles': 'Changed files',
      'failure': 'Failure context',
      'dependencies': 'Dependencies',
      'verification': 'Verification',
      'workspace': 'Workspace',
      'worktree': 'Worktree',
      'repo': 'Repository',
      'timeline': 'Decision timeline',
      'phase': 'Phase',
      'outcome': 'Outcome',
      'systemEvents': 'System events',
      'taskCounts': 'Task distribution',
      'noSelection': 'None selected',
      'openFromSettings': 'Open',
      'runList': 'Runs',
      'error.LoadFailed': 'Failed to load',
      'error.ActionFailed': 'Action failed',
      'acceptanceRejectHint': 'Rejecting records this decision only; the run still waits for acceptance.',
      'tool.notIndexed': 'This run is not indexed yet; refresh from Settings.',
      'status.DRAFT': 'Draft',
      'status.SPEC_READY': 'Spec ready',
      'status.QUEUED': 'Queued',
      'status.PLANNING': 'Planning',
      'status.RUNNING': 'Running',
      'status.VERIFYING': 'Verifying',
      'status.WAITING_HUMAN': 'Waiting for human',
      'status.BLOCKED': 'Blocked',
      'status.PAUSED': 'Paused',
      'status.COMPLETED': 'Completed',
      'status.CANCELLED': 'Cancelled',
      'phase.prepare': 'Prepare',
      'phase.dispatch': 'Dispatch',
      'phase.execute': 'Execute',
      'phase.verify': 'Verify',
      'phase.review': 'Review',
      'phase.integrate': 'Integrate',
      'phase.accept': 'Accept',
      'phase.human': 'Human',
      'phase.lifecycle': 'Lifecycle',
      'phase.system': 'System',
    };

    let bridge = {
      t: (key) => key,
      subscribe: () => () => {},
    };

    function useT() {
      const [, force] = React.useReducer((value) => value + 1, 0);
      useEffect(() => bridge.subscribe(force), []);
      return bridge.t;
    }

    const STATUS_META = {
      DRAFT: ['草稿', 'idle'],
      SPEC_READY: ['规格就绪', 'idle'],
      QUEUED: ['排队中', 'idle'],
      PLANNING: ['规划中', 'warn'],
      RUNNING: ['执行中', 'brand'],
      VERIFYING: ['验证中', 'warn'],
      WAITING_HUMAN: ['等待人工', 'warn'],
      BLOCKED: ['已阻塞', 'error'],
      PAUSED: ['已暂停', 'idle'],
      COMPLETED: ['已完成', 'success'],
      CANCELLED: ['已取消', 'idle'],
    };

    const OUTCOME_COLOR = {
      pass: 'var(--dsw-alias-state-success-primary)',
      fail: 'var(--dsw-alias-state-error-primary)',
      blocked: 'var(--dsw-alias-state-error-primary)',
      waiting: 'var(--dsw-alias-state-warn-primary)',
      info: 'var(--dsw-alias-label-secondary)',
    };

    const PHASE_FALLBACK = {
      prepare: '准备',
      dispatch: '调度',
      execute: '执行',
      verify: '验证',
      review: '评审',
      integrate: '集成',
      accept: '验收',
      human: '人工',
      lifecycle: '生命周期',
      system: '系统',
    };

    function statusLabel(status, t) {
      const key = `status.${status}`;
      const label = t(key);
      return typeof label === 'string' && label !== key ? label : status;
    }

    function phaseLabel(phase, t) {
      const key = `phase.${phase}`;
      const label = t(key);
      return typeof label === 'string' && label !== key ? label : (PHASE_FALLBACK[phase] ?? phase);
    }

    function statusColor(status) {
      const meta = STATUS_META[status];
      if (meta === undefined) return 'var(--dsw-alias-state-idle-primary)';
      switch (meta[1]) {
        case 'success': return 'var(--dsw-alias-state-success-primary)';
        case 'error': return 'var(--dsw-alias-state-error-primary)';
        case 'warn': return 'var(--dsw-alias-state-warn-primary)';
        case 'brand': return 'var(--dsw-alias-brand-primary)';
        default: return 'var(--dsw-alias-state-idle-primary)';
      }
    }

    function fmtTime(value) {
      if (typeof value !== 'string' || value.length === 0) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value;
      return date.toLocaleString(undefined, {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
    }

    function fmtBytes(value) {
      if (typeof value !== 'number') return '';
      if (value < 1024) return `${value} B`;
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
      return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    }

    function shortPath(value, max = 70) {
      if (typeof value !== 'string') return '';
      return value.length <= max ? value : `…${value.slice(-(max - 1))}`;
    }

    function cx(...values) {
      return values.filter(Boolean).join(' ');
    }

    function openDelivery(detail) {
      window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail }));
    }

    async function getJson(url) {
      const response = await fetch(url, {
        cache: 'no-store',
        credentials: 'same-origin',
        ...(TOKEN ? { headers: { 'x-delivery-loop-token': TOKEN } } : {}),
      });
      const text = await response.text();
      let value;
      try {
        value = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        value = { error: text };
      }
      if (!response.ok) throw new Error(value?.error ?? `HTTP ${response.status}`);
      return value;
    }

    async function postJson(url, body) {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(TOKEN ? { 'x-delivery-loop-token': TOKEN } : {}),
        },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const text = await response.text();
      let value;
      try {
        value = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        value = { error: text };
      }
      if (!response.ok) throw new Error(value?.error ?? `HTTP ${response.status}`);
      return value;
    }

    function runQuery(repoRoot) {
      return repoRoot ? `?repo_root=${encodeURIComponent(repoRoot)}` : '';
    }

    function useRuns(repoRoot, intervalMs = 4000) {
      const [state, setState] = useState({ runs: [], error: null, loading: true });
      const alive = useRef(true);
      const load = useMemo(() => async () => {
        try {
          const value = await getJson(`${API}/runs${runQuery(repoRoot)}`);
          if (alive.current) setState({ runs: value.runs ?? [], error: null, loading: false });
        } catch (error) {
          if (alive.current) setState((current) => ({ ...current, error: error.message, loading: false }));
        }
      }, [repoRoot]);
      useEffect(() => {
        alive.current = true;
        void load();
        const timer = setInterval(() => void load(), intervalMs);
        return () => {
          alive.current = false;
          clearInterval(timer);
        };
      }, [load, intervalMs]);
      return { ...state, reload: load };
    }

    function useRunDetail(runId, repoRoot, intervalMs = 2500, enabled = true, options = {}) {
      const includeFiles = options.includeFiles !== false;
      const includeArtifacts = options.includeArtifacts !== false;
      const [state, setState] = useState({ detail: null, error: null, loading: true });
      const alive = useRef(true);
      const load = useMemo(() => async () => {
        if (!enabled || !runId) return;
        try {
          const value = await getJson(`${API}/run?run_id=${encodeURIComponent(runId)}${repoRoot ? `&repo_root=${encodeURIComponent(repoRoot)}` : ''}&include_files=${includeFiles ? 1 : 0}&include_artifacts=${includeArtifacts ? 1 : 0}`);
          if (alive.current) setState({ detail: value, error: null, loading: false });
        } catch (error) {
          if (alive.current) setState((current) => ({ ...current, error: error.message, loading: false }));
        }
      }, [runId, repoRoot, enabled, includeFiles, includeArtifacts]);
      useEffect(() => {
        alive.current = true;
        if (!enabled || !runId) {
          setState({ detail: null, error: null, loading: false });
          return () => { alive.current = false; };
        }
        void load();
        const timer = setInterval(() => void load(), intervalMs);
        return () => {
          alive.current = false;
          clearInterval(timer);
        };
      }, [load, intervalMs, enabled, runId]);
      return { ...state, reload: load };
    }

    function StatusPill({ status, size = 'normal' }) {
      const t = useT();
      return h('span', {
        className: cx('dl-pill', size === 'small' && 'dl-pill-small'),
        style: { color: statusColor(status), borderColor: statusColor(status) },
        title: status,
      }, h('span', { className: 'dl-dot', style: { background: statusColor(status) } }), statusLabel(status, t));
    }

    function Progress({ done, total }) {
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      return h('div', { className: 'dl-progress' },
        h('div', { className: 'dl-progress-track' },
          h('div', { className: 'dl-progress-fill', style: { width: `${pct}%` } })),
        h('span', { className: 'dl-progress-label' }, `${done}/${total} · ${pct}%`));
    }

    function Stat({ label, value, tone }) {
      return h('div', { className: 'dl-stat' },
        h('div', { className: 'dl-stat-label' }, label),
        h('div', { className: 'dl-stat-value', style: tone ? { color: tone } : undefined }, value));
    }

    function TabButton({ active, children, onClick }) {
      return h('button', {
        type: 'button',
        role: 'tab',
        'aria-selected': active,
        className: cx('dl-tab', active && 'dl-tab-active'),
        onClick,
      }, children);
    }

    function Button({ children, onClick, tone = 'default', disabled = false, title }) {
      return h('button', {
        type: 'button',
        className: cx('dl-button', tone !== 'default' && `dl-button-${tone}`),
        onClick,
        disabled,
        title,
      }, children);
    }

    function ErrorBanner({ error }) {
      if (!error) return null;
      return h('div', { className: 'dl-banner dl-banner-error' }, error);
    }

    function Empty({ children }) {
      return h('div', { className: 'dl-empty' }, children);
    }

    function DecisionCard({ runId, repoRoot, decision, onDone }) {
      const t = useT();
      const [value, setValue] = useState('');
      const [busy, setBusy] = useState(false);
      const busyRef = useRef(false);
      const [error, setError] = useState(null);
      const options = Array.isArray(decision.options) && decision.options.length > 0 ? decision.options : ['approve', 'reject'];
      const acceptance = decision.data?.type === 'acceptance';
      const submit = async (response) => {
        if (busyRef.current) return;
        const answer = response ?? value;
        if (answer.trim().length === 0) return;
        busyRef.current = true;
        setBusy(true);
        setError(null);
        try {
          await postJson(`${API}/action`, {
            action: 'respond',
            run_id: runId,
            ...(repoRoot ? { repo_root: repoRoot } : {}),
            decision_id: decision.data?.decision_id ?? decision.id.replace(/^pending-/, ''),
            response: answer,
          });
          setValue('');
          await onDone();
        } catch (failure) {
          setError(failure.message);
        } finally {
          busyRef.current = false;
          setBusy(false);
        }
      };
      return h('div', { className: 'dl-decision dl-decision-pending' },
        h('div', { className: 'dl-decision-head' },
          h('span', { className: 'dl-decision-phase' }, t('pending')),
          h('span', { className: 'dl-decision-time' }, fmtTime(decision.timestamp))),
        h('div', { className: 'dl-decision-title' }, decision.title),
        decision.detail ? h('div', { className: 'dl-decision-detail' }, decision.detail) : null,
        acceptance ? h('div', { className: 'dl-hint' }, t('acceptanceRejectHint')) : null,
        h('div', { className: 'dl-decision-actions' },
          ...options.map((option) => h(Button, {
            key: option,
            tone: option === 'approve' || option === '通过' ? 'primary' : 'default',
            disabled: busy,
            onClick: () => void submit(option),
          }, option === 'approve' ? t('approve') : option === 'reject' ? t('reject') : option)),
          h('input', {
            className: 'dl-input',
            value,
            'aria-label': t('answerPlaceholder'),
            placeholder: t('answerPlaceholder'),
            onChange: (event) => setValue(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter' && !event.nativeEvent?.isComposing) void submit(); },
          }),
          h(Button, { disabled: busy || value.trim().length === 0, onClick: () => void submit() }, busy ? '…' : t('answer'))),
        error ? h('div', { className: 'dl-inline-error' }, error) : null);
    }

    function DecisionTimeline({ runId, repoRoot, decisions, onDone }) {
      const t = useT();
      if (!decisions || decisions.length === 0) return h(Empty, null, t('noDecisions'));
      return h('div', { className: 'dl-timeline' },
        decisions.map((decision) => {
          if (decision.pending) {
            return h(DecisionCard, { key: decision.id, runId, repoRoot, decision, onDone });
          }
          return h('div', { key: decision.id, className: 'dl-decision' },
            h('div', {
              className: 'dl-decision-rail',
              style: { background: OUTCOME_COLOR[decision.outcome] ?? OUTCOME_COLOR.info },
            }),
            h('div', { className: 'dl-decision-body' },
              h('div', { className: 'dl-decision-head' },
                h('span', { className: 'dl-decision-phase' }, phaseLabel(decision.phase, t)),
                h('span', { className: 'dl-decision-code' }, decision.code),
                h('span', { className: 'dl-decision-time' }, fmtTime(decision.timestamp))),
              h('div', { className: 'dl-decision-title' }, decision.title),
              decision.detail ? h('div', { className: 'dl-decision-detail' }, decision.detail) : null,
              h('div', { className: 'dl-decision-meta' },
                decision.task_id ? h('span', { className: 'dl-chip' }, decision.task_id) : null,
                h('span', {
                  className: 'dl-chip',
                  style: { color: OUTCOME_COLOR[decision.outcome] ?? undefined },
                }, decision.outcome))));
        }));
    }

    function TaskList({ tasks }) {
      const t = useT();
      const [expanded, setExpanded] = useState(null);
      if (!tasks || tasks.length === 0) return h(Empty, null, t('noTasks'));
      return h('div', { className: 'dl-task-list' },
        tasks.map((task) => {
          const open = expanded === task.id;
          return h('div', { key: task.id, className: cx('dl-task', open && 'dl-task-open') },
            h('button', {
              type: 'button',
              className: 'dl-task-head',
              onClick: () => setExpanded(open ? null : task.id),
            },
              h('span', { className: 'dl-dot', style: { background: statusColor(task.status) } }),
              h('span', { className: 'dl-task-id' }, task.id),
              h('span', { className: 'dl-task-title' }, task.title),
              h('span', { className: 'dl-task-status' }, task.status),
              h('span', { className: 'dl-task-attempt' }, `${t('attempt')} ${task.attempt}/${task.max_attempts}`),
              h('span', { className: 'dl-chevron' }, open ? '▾' : '▸')),
            open ? h('div', { className: 'dl-task-body' },
              h('div', { className: 'dl-kv' },
                h('span', null, t('role')), h('span', null, task.worker_role),
                h('span', null, t('origin')), h('span', null, task.origin),
                h('span', null, 'type'), h('span', null, task.type),
                h('span', null, t('dependencies')), h('span', null, task.depends_on.join(', ') || '—'),
                h('span', null, t('workspace')), h('span', { className: 'dl-mono' }, shortPath(task.workspace_path ?? '—', 90))),
              task.last_summary ? h('div', { className: 'dl-sub' }, task.last_summary) : null,
              task.failure_context?.summary ? h('div', { className: 'dl-failure' },
                h('strong', null, `${t('failure')}: `), task.failure_context.summary) : null,
              task.verification_commands.length > 0 ? h('div', { className: 'dl-chips' },
                ...task.verification_commands.map((command) => h('code', { key: command, className: 'dl-chip dl-mono' }, command))) : null,
              task.changed_files.length > 0 ? h('div', { className: 'dl-files-inline' },
                h('div', { className: 'dl-sub' }, t('changedFiles')),
                ...task.changed_files.map((path) => h('div', { key: path, className: 'dl-mono dl-file-row' }, path))) : null) : null);
        }));
    }

    function FilePreview({ runId, repoRoot, path, source, taskId, onClose }) {
      const t = useT();
      const [mode, setMode] = useState('content');
      const initialSource = source ?? 'worktree';
      const [activeSource, setActiveSource] = useState(initialSource);
      const [state, setState] = useState({ loading: true, error: null, data: null, diff: null });
      const taskQuery = taskId ? `&task_id=${encodeURIComponent(taskId)}` : '';
      useEffect(() => {
        setActiveSource(source ?? 'worktree');
      }, [path, source]);
      useEffect(() => {
        let alive = true;
        setMode('content');
        setState({ loading: true, error: null, data: null, diff: null });
        getJson(`${API}/file?run_id=${encodeURIComponent(runId)}&path=${encodeURIComponent(path)}&source=${activeSource}${taskQuery}${repoRoot ? `&repo_root=${encodeURIComponent(repoRoot)}` : ''}`)
          .then((data) => { if (alive) setState({ loading: false, error: null, data, diff: null }); })
          .catch((error) => { if (alive) setState({ loading: false, error: error.message, data: null, diff: null }); });
        return () => { alive = false; };
      }, [runId, repoRoot, path, activeSource, taskQuery]);
      const showDiff = async () => {
        if (mode === 'diff') {
          setMode('content');
          return;
        }
        setMode('diff');
        if (state.diff !== null) return;
        try {
          const value = await getJson(`${API}/diff?run_id=${encodeURIComponent(runId)}&path=${encodeURIComponent(path)}${taskQuery}${repoRoot ? `&repo_root=${encodeURIComponent(repoRoot)}` : ''}`);
          setState((current) => ({ ...current, diff: value.diff ?? '' }));
        } catch (error) {
          setState((current) => ({ ...current, diff: `Diff unavailable: ${error.message}` }));
        }
      };
      return h('div', { className: 'dl-preview' },
        h('div', { className: 'dl-preview-head' },
          h('span', { className: 'dl-preview-path dl-mono', title: path }, path),
          activeSource !== 'artifact'
            ? h('div', { className: 'dl-source-toggle' },
              h('button', {
                type: 'button',
                className: cx('dl-source-button', activeSource === 'worktree' && 'dl-source-active'),
                onClick: () => setActiveSource('worktree'),
              }, t('worktree')),
              h('button', {
                type: 'button',
                className: cx('dl-source-button', activeSource === 'repo' && 'dl-source-active'),
                onClick: () => setActiveSource('repo'),
              }, t('repo')))
            : null,
          h('div', { className: 'dl-preview-actions' },
            activeSource === 'worktree'
              ? h(Button, { onClick: () => void showDiff(), disabled: state.data?.binary === true }, mode === 'diff' ? t('preview') : t('diff'))
              : null,
            onClose ? h(Button, { onClick: onClose }, t('back')) : null)),
        state.loading ? h(Empty, null, t('loading')) : null,
        state.error ? h(ErrorBanner, { error: state.error }) : null,
        state.data ? h('div', { className: 'dl-preview-body' },
          state.data.binary ? h(Empty, null, t('binary'))
            : h('pre', { className: 'dl-code' }, mode === 'diff' ? (state.diff ?? '…') : state.data.content),
          state.data.truncated ? h('div', { className: 'dl-hint' }, t('truncated')) : null) : null);
    }

    function FilesTab({ detail, runId, repoRoot }) {
      const t = useT();
      const [selected, setSelected] = useState(null);
      const taskFiles = useMemo(() => {
        const grouped = [];
        for (const task of detail.files.tasks ?? []) {
          if (task.paths.length > 0) grouped.push({ id: task.task_id, title: task.title, paths: task.paths, status: task.status });
        }
        return grouped;
      }, [detail.files.tasks]);
      return h('div', { className: 'dl-split' },
        h('div', { className: 'dl-file-list' },
          h('div', { className: 'dl-section-title' }, `${t('changedFiles')} (${detail.files.changed.length})`),
          detail.files.changed.length === 0 ? h(Empty, null, t('noFiles')) : null,
          ...detail.files.changed.map((path) => h('button', {
            key: path,
            type: 'button',
            className: cx('dl-file-item', selected?.path === path && !selected?.taskId && 'dl-file-active'),
            onClick: () => setSelected({ path, source: 'worktree' }),
          }, h('span', { className: 'dl-mono' }, path))),
          taskFiles.length > 0 ? h('div', { className: 'dl-section-title' }, t('tasks')) : null,
          ...taskFiles.map((group) => h('div', { key: group.id, className: 'dl-file-group' },
            h('div', { className: 'dl-file-group-title' }, `${group.id} · ${group.title}`),
            ...group.paths.map((path) => h('button', {
              key: `${group.id}:${path}`,
              type: 'button',
              className: cx('dl-file-item dl-file-child', selected?.path === path && selected?.taskId === group.id && 'dl-file-active'),
              onClick: () => setSelected({ path, source: 'worktree', taskId: group.id }),
            }, h('span', { className: 'dl-mono' }, path)))))),
        h('div', { className: 'dl-file-pane' },
          selected
            ? h(FilePreview, { runId, repoRoot, path: selected.path, source: selected.source, taskId: selected.taskId })
            : h(Empty, null, t('clickFile'))));
    }

    function ArtifactsTab({ detail, runId, repoRoot }) {
      const t = useT();
      const [selected, setSelected] = useState(null);
      return h('div', { className: 'dl-split' },
        h('div', { className: 'dl-file-list' },
          h('div', { className: 'dl-section-title' }, `${t('artifacts')} (${detail.artifacts.length})`),
          detail.artifacts.length === 0 ? h(Empty, null, t('noArtifacts')) : null,
          ...detail.artifacts.map((artifact) => h('button', {
            key: artifact.path,
            type: 'button',
            className: cx('dl-file-item', selected?.path === artifact.path && 'dl-file-active'),
            onClick: () => setSelected({ path: artifact.path, source: 'artifact' }),
          }, h('span', { className: 'dl-mono' }, artifact.path), h('span', { className: 'dl-file-size' }, fmtBytes(artifact.size))))),
        h('div', { className: 'dl-file-pane' },
          selected
            ? h(FilePreview, { runId, repoRoot, path: selected.path, source: selected.source })
            : h(Empty, null, t('clickFile'))));
    }

    function EventsTab({ detail }) {
      const t = useT();
      if (detail.events.length === 0) return h(Empty, null, t('noEvents'));
      return h('div', { className: 'dl-events' },
        h('div', { className: 'dl-section-title' }, t('systemEvents')),
        ...detail.events.slice().reverse().map((event) => h('div', { key: event.id, className: 'dl-event' },
          h('span', { className: 'dl-event-time' }, fmtTime(event.timestamp)),
          h('span', { className: 'dl-event-type' }, event.type),
          h('span', { className: 'dl-event-message' }, event.task_id ? `[${event.task_id}] ` : '', event.message ?? ''))));
    }

    function OverviewTab({ detail, onDone }) {
      const t = useT();
      const pending = detail.decisions.filter((decision) => decision.pending);
      return h('div', { className: 'dl-overview' },
        h('div', { className: 'dl-stats' },
          h(Stat, { label: t('progress'), value: `${detail.done_tasks}/${detail.total_tasks}` }),
          h(Stat, { label: t('status'), value: statusLabel(detail.status, t), tone: statusColor(detail.status) }),
          h(Stat, { label: t('tokens'), value: detail.total_tokens_used.toLocaleString() + (detail.usage_incomplete ? ' (incomplete)' : '') }),
          h(Stat, { label: t('pending'), value: String(pending.length), tone: pending.length > 0 ? 'var(--dsw-alias-state-warn-primary)' : undefined })),
        h(Progress, { done: detail.done_tasks, total: detail.total_tasks }),
        h('div', { className: 'dl-columns' },
          h('div', { className: 'dl-column' },
            h('div', { className: 'dl-section-title' }, t('taskCounts')),
            h('div', { className: 'dl-chips' }, ...Object.entries(detail.task_counts).map(([status, count]) =>
              h('span', { key: status, className: 'dl-chip' }, `${status} ${count}`))),
            h('div', { className: 'dl-section-title' }, t('current')),
            detail.current_task_ids.length === 0 ? h(Empty, null, '—') : h('div', { className: 'dl-chips' },
              ...detail.current_task_ids.map((id) => h('span', { key: id, className: 'dl-chip' }, id))),
            h('div', { className: 'dl-section-title' }, t('spec')),
            h('pre', { className: 'dl-spec' }, detail.spec_excerpt || t('noSpec'))),
          h('div', { className: 'dl-column' },
            h('div', { className: 'dl-section-title' }, t('pending')),
            pending.length === 0 ? h(Empty, null, t('noPending')) : null,
            ...pending.map((decision) => h(DecisionCard, {
              key: decision.id,
              runId: detail.run_id,
              repoRoot: detail.repo_root,
              decision,
              onDone,
            })),
            h('div', { className: 'dl-section-title' }, t('lastError')),
            h('div', { className: 'dl-error-text' }, detail.last_error || t('noError')))));
    }

    function RunHeader({ detail, onClose, onAction, busy }) {
      const t = useT();
      const canPause = ['RUNNING', 'VERIFYING', 'PLANNING', 'QUEUED'].includes(detail.status);
      const canResume = ['PAUSED', 'BLOCKED', 'QUEUED'].includes(detail.status);
      const canCancel = !['COMPLETED', 'CANCELLED'].includes(detail.status);
      return h('div', { className: 'dl-header' },
        h('div', { className: 'dl-header-main' },
          h('div', { className: 'dl-header-title' },
            h('span', { className: 'dl-title' }, detail.title || detail.run_id),
            h(StatusPill, { status: detail.status })),
          h('div', { className: 'dl-header-sub' },
            h('span', { className: 'dl-mono' }, detail.run_id),
            h('span', { className: 'dl-sep' }, '·'),
            h('span', { className: 'dl-mono dl-muted', title: detail.repo_root }, shortPath(detail.repo_root, 80)),
            h('span', { className: 'dl-sep' }, '·'),
            h('span', { className: 'dl-muted' }, `${t('updated')} ${fmtTime(detail.updated_at)}`))),
        h('div', { className: 'dl-header-actions' },
          canPause ? h(Button, { disabled: busy, onClick: () => void onAction('pause') }, t('pause')) : null,
          canResume ? h(Button, { disabled: busy, onClick: () => void onAction('resume') }, t('resume')) : null,
          canCancel ? h(Button, { tone: 'danger', disabled: busy, onClick: () => void onAction('cancel') }, t('cancel')) : null,
          h(Button, { disabled: busy, onClick: () => void onAction('export_report') }, t('export')),
          h('button', { type: 'button', className: 'dl-close', onClick: onClose, title: t('close'), 'aria-label': t('close') }, '×')));
    }

    function DeliveryOverlay() {
      const t = useT();
      const panelRef = useRef(null);
      const restoreFocus = useRef(null);
      const [session, setSession] = useState({ open: false, runId: null, repoRoot: null });
      const [tab, setTab] = useState('overview');
      const [busy, setBusy] = useState(false);
      const [actionError, setActionError] = useState(null);
      const detailState = useRunDetail(
        session.runId,
        session.repoRoot,
        2500,
        session.open && Boolean(session.runId),
        { includeFiles: tab === 'files', includeArtifacts: tab === 'artifacts' },
      );
      useEffect(() => {
        const listener = (event) => {
          const detail = event.detail ?? {};
          setSession({ open: true, runId: detail.runId ?? null, repoRoot: detail.repoRoot ?? null });
          setTab(detail.tab ?? 'overview');
          setActionError(null);
        };
        window.addEventListener(OPEN_EVENT, listener);
        return () => window.removeEventListener(OPEN_EVENT, listener);
      }, []);
      useEffect(() => {
        if (!session.open) return undefined;
        restoreFocus.current = document.activeElement;
        const focusTimer = setTimeout(() => panelRef.current?.focus(), 0);
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            setSession((current) => ({ ...current, open: false }));
            return;
          }
          if (event.key !== 'Tab' || panelRef.current === null) return;
          const candidates = [...panelRef.current.querySelectorAll(
            'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
          )].filter((element) => element.offsetParent !== null);
          if (candidates.length === 0) return;
          const first = candidates[0];
          const last = candidates[candidates.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => {
          clearTimeout(focusTimer);
          window.removeEventListener('keydown', onKeyDown);
          restoreFocus.current?.focus?.();
        };
      }, [session.open]);
      const detail = detailState.detail;
      const action = async (name, extra) => {
        if (!detail) return;
        if (name === 'cancel' && !window.confirm(t('cancelConfirm'))) return;
        setBusy(true);
        setActionError(null);
        try {
          await postJson(`${API}/action`, {
            action: name,
            run_id: detail.run_id,
            repo_root: detail.repo_root,
            ...(extra ?? {}),
          });
          await detailState.reload();
        } catch (error) {
          setActionError(error.message);
        } finally {
          setBusy(false);
        }
      };
      if (!session.open) return null;
      const reload = async () => { await detailState.reload(); };
      return h(React.Fragment, null,
        h(Styles),
        h('div', { className: 'dl-backdrop', onMouseDown: (event) => { if (event.target === event.currentTarget) setSession((current) => ({ ...current, open: false })); } },
          h('div', { ref: panelRef, tabIndex: -1, className: 'dl-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': detail ? (detail.title || detail.run_id) : t('nav') },
            detail
              ? h(RunHeader, {
                detail,
                busy,
                onClose: () => setSession((current) => ({ ...current, open: false })),
                onAction: action,
              })
              : h('div', { className: 'dl-header' },
                h('div', { className: 'dl-header-title' }, h('span', { className: 'dl-title' }, t('loading'))),
                h('button', { type: 'button', className: 'dl-close', onClick: () => setSession((current) => ({ ...current, open: false })), title: t('close'), 'aria-label': t('close') }, '×')),
            actionError ? h('div', { className: 'dl-banner dl-banner-error' }, actionError) : null,
            detailState.error ? h('div', { className: 'dl-banner dl-banner-error' }, detailState.error) : null,
            detail ? h(React.Fragment, null,
              h('div', { className: 'dl-tabs', role: 'tablist' },
                ...[['overview', t('overview')], ['tasks', t('tasks')], ['decisions', t('decisions')], ['files', t('files')], ['artifacts', t('artifacts')], ['events', t('events')]]
                  .map(([key, label]) => h(TabButton, { key, active: tab === key, onClick: () => setTab(key) }, label))),
              h('div', { className: 'dl-content' },
                tab === 'overview' ? h(OverviewTab, { detail, onDone: reload }) : null,
                tab === 'tasks' ? h(TaskList, { tasks: detail.tasks }) : null,
                tab === 'decisions' ? h(DecisionTimeline, { runId: detail.run_id, repoRoot: detail.repo_root, decisions: detail.decisions, onDone: reload }) : null,
                tab === 'files' ? h(FilesTab, { detail, runId: detail.run_id, repoRoot: detail.repo_root }) : null,
                tab === 'artifacts' ? h(ArtifactsTab, { detail, runId: detail.run_id, repoRoot: detail.repo_root }) : null,
                tab === 'events' ? h(EventsTab, { detail }) : null))
              : h('div', { className: 'dl-content' }, h(Empty, null, t('loading'))))));
    }

    function DeliveryDock({ sessionId, useSessions }) {
      const t = useT();
      const cwd = useSessions((snapshot) => snapshot.byId[sessionId]?.cwd);
      const { runs } = useRuns(cwd, 4000);
      const active = useMemo(() => {
        if (!runs || runs.length === 0) return null;
        const live = runs.find((run) => ['PLANNING', 'RUNNING', 'VERIFYING', 'WAITING_HUMAN', 'PAUSED', 'BLOCKED', 'QUEUED'].includes(run.status));
        return live ?? runs[0];
      }, [runs]);
      if (!cwd || !active) return null;
      return h(React.Fragment, null,
        h(Styles),
        h('button', {
          type: 'button',
          className: 'dl-dock',
          onClick: () => openDelivery({ repoRoot: cwd, runId: active.run_id }),
          title: t('dock.open'),
        },
          h('span', { className: 'dl-dock-brand' }, 'Delivery Loop'),
          h(StatusPill, { status: active.status, size: 'small' }),
          h('span', { className: 'dl-dock-title' }, active.title || active.run_id),
          h('span', { className: 'dl-dock-progress' }, `${active.done_tasks}/${active.total_tasks}`),
          active.pending_decision_ids.length > 0
            ? h('span', { className: 'dl-dock-badge' }, `! ${active.pending_decision_ids.length}`)
            : null,
          h('span', { className: 'dl-dock-open' }, '›')));
    }

    function RunRow({ run, onOpen }) {
      const t = useT();
      return h('div', { className: 'dl-run-row' },
        h('div', { className: 'dl-run-main' },
          h('div', { className: 'dl-run-title' }, run.title || run.run_id),
          h('div', { className: 'dl-run-sub' },
            h('span', { className: 'dl-mono' }, run.run_id),
            h('span', { className: 'dl-sep' }, '·'),
            h('span', { className: 'dl-mono dl-muted', title: run.repo_root }, shortPath(run.repo_root, 70)),
            h('span', { className: 'dl-sep' }, '·'),
            h('span', null, t('updated') + ' ' + fmtTime(run.updated_at)))),
        h('div', { className: 'dl-run-side' },
          h(StatusPill, { status: run.status, size: 'small' }),
          h('span', { className: 'dl-run-progress' }, `${run.done_tasks}/${run.total_tasks}`),
          h(Button, { onClick: () => onOpen(run) }, t('openFromSettings'))));
    }

    function DeliverySettings() {
      const t = useT();
      const { runs, error, loading, reload } = useRuns(undefined, 8000);
      return h(React.Fragment, null,
        h(Styles),
        h('div', { className: 'dl-settings' },
          h('div', { className: 'dl-settings-head' },
            h('div', null,
              h('div', { className: 'dl-settings-title' }, t('settings.title')),
              h('div', { className: 'dl-settings-sub' }, t('settings.subtitle'))),
            h(Button, { onClick: () => void reload() }, t('refresh'))),
          error ? h(ErrorBanner, { error }) : null,
          loading ? h(Empty, null, t('loading')) : null,
          !loading && runs.length === 0 ? h(Empty, null, t('settings.empty')) : null,
          h('div', { className: 'dl-run-list' },
            ...runs.map((run) => h(RunRow, {
              key: run.run_id,
              run,
              onOpen: (selected) => openDelivery({ repoRoot: selected.repo_root, runId: selected.run_id }),
            })))));
    }

    function DeliveryToolCard({ toolName, block, sessionId, useSessions }) {
      const t = useT();
      const cwd = useSessions((snapshot) => snapshot.byId[sessionId]?.cwd);
      let runId = null;
      try {
        const value = block?.args?.text?.('run_id');
        if (typeof value === 'string' && value.length > 0) runId = value;
      } catch {
        // Preparing arguments can be incomplete.
      }
      if (runId === null && block?.phase === 'result') {
        try {
          const content = Array.isArray(block.content) ? block.content : [];
          const text = content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n');
          const parsed = JSON.parse(text);
          if (typeof parsed?.run_id === 'string' && parsed.run_id.length > 0) runId = parsed.run_id;
        } catch {
          // A non-JSON tool result is not a run card.
        }
      }
      const { runs } = useRuns(runId ? undefined : cwd, 5000);
      const run = runId
        ? runs.find((candidate) => candidate.run_id === runId) ?? null
        : runs[0] ?? null;
      const label = toolName.replace(/^delivery_/, '').replaceAll('_', ' ');
      const failed = block?.isError === true;
      return h(React.Fragment, null,
        h(Styles),
        h('div', { className: cx('dl-tool-card', failed && 'dl-tool-card-error') },
          h('div', { className: 'dl-tool-head' },
            h('span', { className: 'dl-tool-name' }, `Delivery · ${label}`),
            run ? h(StatusPill, { status: run.status, size: 'small' }) : null,
            failed ? h('span', { className: 'dl-tool-warn' }, t('error.ActionFailed')) : null),
          run
            ? h('div', { className: 'dl-tool-body' },
              h('span', { className: 'dl-tool-title' }, run.title || run.run_id),
              h('span', { className: 'dl-tool-meta' }, `${run.done_tasks}/${run.total_tasks}`),
              run.pending_decision_ids.length > 0
                ? h('span', { className: 'dl-tool-warn' }, `${run.pending_decision_ids.length} pending`)
                : null,
              h(Button, {
                onClick: () => openDelivery({ repoRoot: run.repo_root, runId: run.run_id }),
              }, t('dock.open')))
            : h('div', { className: 'dl-tool-body dl-muted' },
              failed ? t('error.ActionFailed') : block?.phase === 'result' ? t('tool.notIndexed') : t('loading'))));
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'delivery-loop: dictionaries');
      bridge = {
        t: ctx.locale.bind(NS),
        subscribe: (listener) => ctx.locale.subscribe(listener),
      };
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'delivery-loop-dock',
        order: 30,
        label: () => bridge.t('nav'),
      }, DeliveryDock));
      ctx.slots.inject('shell.overlay', function* () {
        yield ctx.slots.register({
          name: 'shell.overlay',
          id: 'delivery-loop-overlay',
          order: 950,
          label: () => bridge.t('nav'),
        }, DeliveryOverlay);
      });
      ctx.slots.inject('settings.section', function* () {
        yield ctx.slots.register({
          name: 'settings.section',
          id: 'delivery-loop',
          order: 45,
          label: () => bridge.t('nav'),
        }, DeliverySettings);
      });
      ctx.slots.inject('tool.call.toolview', function* () {
        for (const key of TOOL_NAMES) {
          yield ctx.slots.register({
            name: 'tool.call.toolview',
            key,
          }, DeliveryToolCard);
        }
      });
    }

    const CSS = `
      .dl-backdrop{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.38);padding:24px;box-sizing:border-box;pointer-events:auto}
      .dl-panel{display:flex;flex-direction:column;width:min(1120px,calc(100vw - 48px));height:min(780px,calc(100vh - 48px));background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;box-shadow:0 24px 80px rgba(0,0,0,.35);overflow:hidden;font-size:13px;line-height:1.5}
      .dl-panel:focus{outline:none}
      .dl-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:16px 18px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
      .dl-header-main{min-width:0;display:flex;flex-direction:column;gap:6px}
      .dl-header-title{display:flex;align-items:center;gap:10px;min-width:0}
      .dl-title{font-size:16px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:620px}
      .dl-header-sub{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px;min-width:0;flex-wrap:wrap}
      .dl-header-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}
      .dl-close{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:22px;line-height:1;width:30px;height:30px;border-radius:8px;cursor:pointer}
      .dl-close:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
      .dl-tabs{display:flex;gap:2px;padding:0 14px;border-bottom:1px solid var(--dsw-alias-border-l1);overflow-x:auto}
      .dl-tab{border:0;background:transparent;color:var(--dsw-alias-label-secondary);padding:10px 12px;font-size:12.5px;cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap}
      .dl-tab:hover{color:var(--dsw-alias-label-primary)}
      .dl-tab-active{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600}
      .dl-content{flex:1;overflow:auto;padding:16px 18px 22px}
      .dl-overview{display:flex;flex-direction:column;gap:16px}
      .dl-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
      .dl-stat{padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
      .dl-stat-label{font-size:11px;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.04em}
      .dl-stat-value{font-size:18px;font-weight:600;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dl-progress{display:flex;align-items:center;gap:10px}
      .dl-progress-track{flex:1;height:8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
      .dl-progress-fill{height:100%;background:var(--dsw-alias-brand-primary);border-radius:999px;transition:width .3s ease}
      .dl-progress-label{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
      .dl-columns{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:18px}
      .dl-column{display:flex;flex-direction:column;gap:8px;min-width:0}
      .dl-section-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.04em;margin-top:4px}
      .dl-chips{display:flex;flex-wrap:wrap;gap:6px}
      .dl-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);font-size:11.5px;color:var(--dsw-alias-label-secondary);max-width:100%;overflow:hidden;text-overflow:ellipsis}
      .dl-spec{margin:0;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto;color:var(--dsw-alias-label-primary)}
      .dl-error-text{padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-state-error-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;white-space:pre-wrap;word-break:break-word}
      .dl-empty{padding:18px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12.5px;border:1px dashed var(--dsw-alias-border-l1);border-radius:10px}
      .dl-banner-error{margin:10px 18px 0;padding:9px 12px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-1);font-size:12px;white-space:pre-wrap;word-break:break-word}
      .dl-pill{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border:1px solid currentColor;border-radius:999px;font-size:11.5px;white-space:nowrap;background:var(--dsw-alias-bg-layer-1)}
      .dl-pill-small{font-size:10.5px;padding:1px 6px}
      .dl-dot{width:6px;height:6px;border-radius:999px;flex:0 0 auto}
      .dl-button{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:5px 10px;border-radius:8px;font-size:12px;cursor:pointer;white-space:nowrap}
      .dl-button:hover{background:var(--dsw-alias-bg-layer-2)}
      .dl-button:disabled{opacity:.55;cursor:default}
      .dl-button-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
      .dl-button-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
      .dl-muted{color:var(--dsw-alias-label-secondary)}
      .dl-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}
      .dl-sep{color:var(--dsw-alias-border-l2)}
      .dl-timeline{display:flex;flex-direction:column;gap:8px}
      .dl-decision{position:relative;display:flex;gap:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
      .dl-decision-pending{border-color:var(--dsw-alias-state-warn-primary);flex-direction:column;gap:6px}
      .dl-decision-rail{width:3px;border-radius:999px;flex:0 0 auto;align-self:stretch}
      .dl-decision-body{min-width:0;flex:1}
      .dl-decision-head{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap}
      .dl-decision-phase{font-weight:600;text-transform:uppercase;letter-spacing:.04em}
      .dl-decision-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;opacity:.8}
      .dl-decision-time{margin-left:auto;white-space:nowrap}
      .dl-decision-title{font-weight:600;margin-top:2px}
      .dl-decision-detail{margin-top:3px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;font-size:12.5px}
      .dl-decision-meta{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}
      .dl-decision-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:4px}
      .dl-input{flex:1;min-width:180px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:5px 9px;font-size:12px;outline:none}
      .dl-input:focus{border-color:var(--dsw-alias-brand-primary)}
      .dl-inline-error{color:var(--dsw-alias-state-error-primary);font-size:11.5px}
      .dl-task-list{display:flex;flex-direction:column;gap:6px}
      .dl-task{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
      .dl-task-head{display:flex;align-items:center;gap:8px;width:100%;padding:9px 12px;border:0;background:transparent;color:inherit;cursor:pointer;text-align:left;font-size:12.5px}
      .dl-task-head:hover{background:var(--dsw-alias-bg-layer-2)}
      .dl-task-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
      .dl-task-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dl-task-status{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
      .dl-task-attempt{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
      .dl-chevron{color:var(--dsw-alias-label-secondary);width:14px;text-align:center}
      .dl-task-body{padding:4px 12px 12px;border-top:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:8px}
      .dl-kv{display:grid;grid-template-columns:110px minmax(0,1fr);gap:3px 8px;font-size:12px;margin-top:8px}
      .dl-kv>span:nth-child(odd){color:var(--dsw-alias-label-secondary)}
      .dl-sub{color:var(--dsw-alias-label-secondary);font-size:12px;white-space:pre-wrap;word-break:break-word}
      .dl-failure{padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-error-primary);font-size:12px;white-space:pre-wrap;word-break:break-word}
      .dl-files-inline{display:flex;flex-direction:column;gap:2px}
      .dl-file-row{color:var(--dsw-alias-label-secondary)}
      .dl-split{display:grid;grid-template-columns:minmax(220px,34%) minmax(0,1fr);gap:14px;min-height:420px}
      .dl-file-list{display:flex;flex-direction:column;gap:2px;max-height:560px;overflow:auto;padding-right:4px}
      .dl-file-item{display:flex;align-items:center;justify-content:space-between;gap:8px;border:0;background:transparent;color:var(--dsw-alias-label-primary);text-align:left;padding:6px 8px;border-radius:7px;cursor:pointer;font-size:12px;min-width:0}
      .dl-file-item:hover{background:var(--dsw-alias-bg-layer-2)}
      .dl-file-item>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dl-file-active{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}
      .dl-file-child{padding-left:16px}
      .dl-file-group-title{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:6px;padding:0 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dl-file-size{font-size:10.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
      .dl-file-pane{min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;display:flex;flex-direction:column;max-height:600px}
      .dl-preview{display:flex;flex-direction:column;min-height:0;height:100%}
      .dl-preview-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);min-width:0}
      .dl-preview-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
      .dl-preview-actions{display:flex;gap:4px;flex:0 0 auto}
      .dl-source-toggle{display:flex;gap:2px;flex:0 0 auto;padding:2px;border-radius:7px;background:var(--dsw-alias-bg-layer-2)}
      .dl-source-button{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;padding:2px 7px;border-radius:5px;cursor:pointer}
      .dl-source-active{background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary)}
      .dl-preview-body{overflow:auto;min-height:0;flex:1}
      .dl-code{margin:0;padding:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word;tab-size:2}
      .dl-hint{padding:6px 10px;color:var(--dsw-alias-label-secondary);font-size:11px;border-top:1px solid var(--dsw-alias-border-l1)}
      .dl-events{display:flex;flex-direction:column;gap:3px}
      .dl-event{display:flex;gap:8px;padding:5px 8px;border-radius:6px;font-size:12px}
      .dl-event:nth-child(odd){background:var(--dsw-alias-bg-layer-1)}
      .dl-event-time{color:var(--dsw-alias-label-secondary);white-space:nowrap;font-size:11px;min-width:118px}
      .dl-event-type{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-brand-primary);min-width:150px}
      .dl-event-message{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
      .dl-dock{display:flex;align-items:center;gap:8px;width:100%;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:5px 10px;cursor:pointer;font-size:11.5px;text-align:left;min-width:0}
      .dl-dock:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
      .dl-dock-brand{font-weight:600;color:var(--dsw-alias-brand-primary);white-space:nowrap;font-size:11px;letter-spacing:.02em}
      .dl-dock-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
      .dl-dock-progress{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-secondary);white-space:nowrap}
      .dl-dock-badge{color:var(--dsw-alias-state-warn-primary);font-weight:600;white-space:nowrap}
      .dl-dock-open{color:var(--dsw-alias-label-secondary);font-size:15px;line-height:1}
      .dl-settings{max-width:960px;margin:0 auto;padding:24px 28px 48px;display:flex;flex-direction:column;gap:18px;color:var(--dsw-alias-label-primary)}
      .dl-settings-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
      .dl-settings-title{font-size:20px;font-weight:600}
      .dl-settings-sub{font-size:13px;color:var(--dsw-alias-label-secondary);margin-top:4px;max-width:640px}
      .dl-run-list{display:flex;flex-direction:column;gap:8px}
      .dl-run-row{display:flex;align-items:center;gap:12px;padding:11px 13px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
      .dl-run-main{flex:1;min-width:0}
      .dl-run-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dl-run-sub{display:flex;gap:6px;align-items:center;color:var(--dsw-alias-label-secondary);font-size:11.5px;margin-top:2px;min-width:0;flex-wrap:wrap}
      .dl-run-side{display:flex;align-items:center;gap:8px;flex:0 0 auto}
      .dl-run-progress{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
      .dl-tool-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:9px 11px;font-size:12px;display:flex;flex-direction:column;gap:6px}
      .dl-tool-card-error{border-color:var(--dsw-alias-state-error-primary)}
      .dl-tool-head{display:flex;align-items:center;gap:8px}
      .dl-tool-name{font-weight:600;color:var(--dsw-alias-label-primary)}
      .dl-tool-body{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .dl-tool-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:340px}
      .dl-tool-meta{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-secondary)}
      .dl-tool-warn{color:var(--dsw-alias-state-warn-primary)}
      @media (max-width:760px){
        .dl-stats{grid-template-columns:repeat(2,minmax(0,1fr))}
        .dl-columns{grid-template-columns:minmax(0,1fr)}
        .dl-split{grid-template-columns:minmax(0,1fr)}
        .dl-panel{width:calc(100vw - 16px);height:calc(100vh - 16px)}
        .dl-backdrop{padding:8px}
        .dl-title{max-width:320px}
      }
    `;

    function Styles() {
      return h('style', { dangerouslySetInnerHTML: { __html: CSS } });
    }

    return { apply, inject: ['slots', 'locale'] };
  },
});
